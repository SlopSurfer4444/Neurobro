#![forbid(unsafe_op_in_unsafe_fn)]

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::env;
use std::io::{Read, Write};
#[cfg(windows)]
use std::time::Instant;

#[cfg(windows)]
use std::ffi::c_void;
#[cfg(windows)]
use std::mem::{size_of, zeroed};
#[cfg(windows)]
use std::ptr::{null, null_mut};
#[cfg(windows)]
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_BROKEN_PIPE, ERROR_IO_INCOMPLETE, ERROR_IO_PENDING, ERROR_NOT_FOUND,
    ERROR_OPERATION_ABORTED, ERROR_PIPE_CONNECTED, ERROR_SUCCESS, GENERIC_READ, GENERIC_WRITE,
    GetHandleInformation, GetLastError, HANDLE, HANDLE_FLAG_INHERIT, LUID, LocalFree, STILL_ACTIVE,
    SetHandleInformation, SetLastError, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
#[cfg(windows)]
use windows_sys::Win32::NetworkManagement::WindowsFirewall::NetworkIsolationGetAppContainerConfig;
#[cfg(windows)]
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSidToSidW,
    ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo, SE_FILE_OBJECT,
};
#[cfg(windows)]
use windows_sys::Win32::Security::Isolation::{
    DeriveAppContainerSidFromAppContainerName, GetAppContainerFolderPath,
};
#[cfg(windows)]
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_SIZE_INFORMATION, AccessCheck, AclSizeInformation,
    CreateRestrictedToken, DACL_SECURITY_INFORMATION, DuplicateTokenEx, EqualSid, GetAce,
    GENERIC_MAPPING, GetAclInformation, GetLengthSid, GetSecurityDescriptorControl,
    GetSecurityDescriptorDacl, GetTokenInformation, IsValidSid, MapGenericMask,
    LABEL_SECURITY_INFORMATION, LUID_AND_ATTRIBUTES, LookupPrivilegeValueW,
    OWNER_SECURITY_INFORMATION, PRIVILEGE_SET, PSID, PrivilegeCheck, SE_DACL_PROTECTED,
    SE_PRIVILEGE_ENABLED, SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES, SID_AND_ATTRIBUTES,
    SYSTEM_MANDATORY_LABEL_ACE, SecurityImpersonation, SetTokenInformation, TOKEN_ADJUST_DEFAULT,
    TOKEN_APPCONTAINER_INFORMATION, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_GROUPS,
    TOKEN_MANDATORY_LABEL, TOKEN_PRIVILEGES, TOKEN_QUERY, TokenAppContainerSid, TokenCapabilities,
    TokenGroups, TokenImpersonation, TokenIntegrityLevel, TokenIsAppContainer, TokenPrimary,
    TOKEN_USER, TokenPrivileges, TokenType, TokenUser,
};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT, FILE_BASIC_INFO, FILE_BEGIN,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_FLAG_OVERLAPPED, FILE_ID_INFO, FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_STANDARD_INFO, FileBasicInfo, FileIdInfo,
    FileStandardInfo, FlushFileBuffers, OPEN_EXISTING, PIPE_ACCESS_INBOUND, PIPE_ACCESS_OUTBOUND,
    READ_CONTROL, ReadFile, SetFilePointerEx, WriteFile,
};
#[cfg(windows)]
use windows_sys::Win32::System::Com::CoTaskMemFree;
#[cfg(windows)]
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
};
#[cfg(windows)]
use windows_sys::Win32::System::Environment::GetEnvironmentVariableW;
#[cfg(windows)]
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JOB_OBJECT_CPU_RATE_CONTROL_ENABLE,
    JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
    JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOB_OBJECT_LIMIT_PROCESS_MEMORY, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
    JOBOBJECT_CPU_RATE_CONTROL_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectCpuRateControlInformation, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
};
#[cfg(windows)]
use windows_sys::Win32::System::Memory::{GetProcessHeap, HeapFree};
#[cfg(windows)]
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
    PIPE_TYPE_BYTE, PIPE_WAIT,
};
#[cfg(windows)]
use windows_sys::Win32::System::SystemServices::{
    ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE, SE_GROUP_INTEGRITY,
    SYSTEM_MANDATORY_LABEL_ACE_TYPE,
    SYSTEM_MANDATORY_LABEL_NO_WRITE_UP,
};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateEventW,
    CreateProcessAsUserW, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT,
    GetCurrentProcess, GetExitCodeProcess, InitializeProcThreadAttributeList, OpenProcessToken,
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
    PROCESS_INFORMATION, QueryFullProcessImageNameW, ResetEvent, ResumeThread,
    STARTF_USESHOWWINDOW, STARTF_USESTDHANDLES, STARTUPINFOEXW, TerminateProcess,
    UpdateProcThreadAttribute, WaitForSingleObject,
};
#[cfg(windows)]
use windows_sys::Win32::UI::Shell::{
    FOLDERID_LocalAppData, FOLDERID_ProgramData, SHGetKnownFolderPath,
};

pub const SUPERVISE_MODE: &str = "supervise-observer-v1";
pub const WORKER_MODE: &str = "worker-observer-v1";
pub const REQUEST_SCHEMA: &str = "decadans.rm0032.native-observer-launcher-request.v1";
pub const RESULT_SCHEMA: &str = "decadans.rm0032.native-observer-launcher-result.v1";
pub const OBSERVER_REQUEST_SCHEMA: &str = "decadans.rm0032.native-observer-request.v1";
pub const OBSERVER_REQUEST_CONSUMER: &str = "rm-0032-phase3-hardening-coordinator";
pub const SUPERVISOR_HANDOFF_SCHEMA: &str =
    "decadans.rm0032.native-observer-launcher-supervisor-handoff.v1";
pub const SUPERVISOR_LEDGER_PROOF_SCHEMA: &str =
    "decadans.rm0032.native-observer-launcher-supervisor-ledger-proof.v1";
pub const MAX_STDOUT_BYTES: usize = 1_114_113;
pub const MAX_STDERR_BYTES: usize = 0;
pub const MAX_WORKER_RESULT_BYTES: usize = 1_500_000;

pub const LAUNCHER_IMAGE: &str =
    r"\\?\C:\Program Files\DecadansNeurobro\rm0032-phase3-native-observer-launcher-v1.exe";
pub const OBSERVER_IMAGE: &str =
    r"\\?\C:\Program Files\DecadansNeurobro\rm0032-phase3-native-observer-v1.exe";
pub const LAUNCHER_IMAGE_DOS: &str =
    r"C:\Program Files\DecadansNeurobro\rm0032-phase3-native-observer-launcher-v1.exe";
pub const OBSERVER_IMAGE_DOS: &str =
    r"C:\Program Files\DecadansNeurobro\rm0032-phase3-native-observer-v1.exe";
pub const FIXED_CWD: &str = r"\\?\C:\ProgramData\DecadansNeurobro";
pub const FIXED_OBSERVER_CWD: &str = r"\\?\C:\ProgramData\DecadansNeurobro\observer-cwd";
pub const LAUNCHER_LEDGER_ROOT: &str = r"\\?\C:\ProgramData\DecadansNeurobro\launcher-ledger-v1";
pub const ACCEPTED_EVIDENCE_ROOT: &str =
    r"\\?\C:\ProgramData\DecadansNeurobro\accepted-evidence-v1";
pub const ACCEPTED_EVIDENCE_ROOT_DOS: &str =
    r"C:\ProgramData\DecadansNeurobro\accepted-evidence-v1";
pub const EXACT_WINDOWS_ROOT: &str = r"C:\Windows";
pub const APPCONTAINER_PACKAGE_NAME: &str = "DecadansNeurobro.Observer.v1";

pub const OUTER_ACTIVE_PROCESS_LIMIT: u32 = 2;
pub const INNER_ACTIVE_PROCESS_LIMIT: u32 = 1;
pub const PROCESS_MEMORY_LIMIT_BYTES: u64 = 64 * 1024 * 1024;
pub const JOB_MEMORY_LIMIT_BYTES: u64 = 128 * 1024 * 1024;
pub const CPU_RATE_PERCENT: u32 = 25;
pub const THREAD_SAMPLE_LIMIT: u32 = 4;
pub const DRAIN_GRACE_MS: u64 = 5_000;
pub const EXACT_INHERITED_HANDLE_COUNT: usize = 3;
pub const SUPERVISOR_IS_OUTER_JOB_BORN: bool = false;
pub const WORKER_MUST_ALREADY_BE_OUTER_CONTAINED: bool = true;
pub const OBSERVER_IS_INNER_JOB_BORN: bool = false;
pub const CREATE_WITH_SHELL: bool = false;
pub const CREATE_HIDDEN: bool = true;
pub const WORKER_ARGV: [&str; 2] = [LAUNCHER_IMAGE, WORKER_MODE];
pub const OBSERVER_ARGV: [&str; 2] = [OBSERVER_IMAGE, "observe-v1"];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Mode {
    Supervisor,
    Worker,
}

pub fn parse_mode(arguments: &[String]) -> Result<Mode, &'static str> {
    match arguments {
        [program, mode] if !program.is_empty() && mode == SUPERVISE_MODE => Ok(Mode::Supervisor),
        [program, mode] if !program.is_empty() && mode == WORKER_MODE => Ok(Mode::Worker),
        _ => Err("exactly one fixed launcher mode is required"),
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChildStartEvidence {
    NeverStarted,
    Started,
    Ambiguous,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LedgerState {
    Unattempted,
    DurableConsumed,
    StickyCollision,
    StickyUnknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PipeState {
    Uninitialized,
    Open,
    Prepared,
    Pending,
    Eof,
    CancelPending,
    Retired,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContainmentState {
    Unstarted,
    SuspendedUnassigned,
    OuterAssignedPendingVerify,
    InnerAssignedPendingVerify,
    OuterAssignedVerified,
    InnerAssignedVerified,
    ResumedExactlyOnce,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TypedHandleKind {
    StdinRead,
    StdinWrite,
    StdoutRead,
    StdoutWrite,
    StderrRead,
    StderrWrite,
    Process,
    Thread,
    OuterJob,
    InnerJob,
    HeldImage,
    HeldAncestor,
    Ledger,
    OverlappedEvent,
    Token,
    Snapshot,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WireEnvelope {
    pub schema: String,
    pub version: String,
    pub request_id: String,
    pub correlation_id: String,
    pub carrier_sha256: String,
    pub launcher_image_path: String,
    pub launcher_image_sha256: String,
    pub observer_image_path: String,
    pub observer_image_sha256: String,
    pub evidence_root_absolute_path: String,
    pub stdin_sha256: String,
    pub stdin_byte_count: u64,
    pub deadline_ms: u64,
}

pub fn validate_wire_envelope(envelope: &WireEnvelope) -> Result<(), &'static str> {
    if envelope.schema != REQUEST_SCHEMA
        || envelope.version != "v1"
        || envelope.request_id.is_empty()
        || envelope.correlation_id.is_empty()
        || envelope.carrier_sha256.is_empty()
        || envelope.launcher_image_path != LAUNCHER_IMAGE_DOS
        || envelope.launcher_image_sha256.is_empty()
        || envelope.observer_image_path != OBSERVER_IMAGE_DOS
        || envelope.observer_image_sha256.is_empty()
        || envelope.evidence_root_absolute_path != ACCEPTED_EVIDENCE_ROOT_DOS
        || envelope.stdin_sha256.is_empty()
        || envelope.stdin_byte_count == 0
        || envelope.deadline_ms == 0
        || envelope.deadline_ms > 10_000
    {
        return Err("wire envelope is outside the fixed launcher contract");
    }
    Ok(())
}

fn exact_lower_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn parse_canonical_wire_envelope(bytes: &[u8]) -> Result<WireEnvelope, &'static str> {
    if bytes.is_empty() || bytes.len() > MAX_LAUNCHER_HEADER_BYTES || bytes.contains(&b'\n') {
        return Err("wire envelope length is outside the fixed cap");
    }
    let envelope: WireEnvelope =
        serde_json::from_slice(bytes).map_err(|_| "wire envelope is not strict JSON")?;
    validate_wire_envelope(&envelope)?;
    if !exact_lower_sha256(&envelope.carrier_sha256)
        || !exact_lower_sha256(&envelope.launcher_image_sha256)
        || !exact_lower_sha256(&envelope.observer_image_sha256)
        || !exact_lower_sha256(&envelope.stdin_sha256)
    {
        return Err("wire envelope hashes are not exact lowercase SHA-256");
    }
    let canonical = serde_json::to_vec(&envelope).map_err(|_| "wire envelope encoding failed")?;
    if canonical != bytes {
        return Err("wire envelope is not canonical JSON");
    }
    Ok(envelope)
}

pub const MAX_LAUNCHER_HEADER_BYTES: usize = 8 * 1024;
pub const MAX_OBSERVER_PAYLOAD_BYTES: usize = 64 * 1024;
pub const MAX_HANDOFF_BYTES: usize =
    MAX_LAUNCHER_HEADER_BYTES + MAX_OBSERVER_PAYLOAD_BYTES + 8 * 1024 + 2;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LedgerStage {
    SupervisorBeforeWorker,
    WorkerBeforeObserver,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LedgerRecord {
    pub schema: String,
    pub stage: LedgerStage,
    pub envelope_header_sha256: String,
    pub observer_payload_sha256: String,
    pub ledger_identity_sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SupervisorLedgerProof {
    pub schema: String,
    pub supervisor_ledger_identity_sha256: String,
    pub supervisor_ledger_record_sha256: String,
    pub envelope_header_sha256: String,
    pub observer_payload_sha256: String,
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn ledger_identity(stage: LedgerStage, header_hash: &str, payload_hash: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"decadans.rm0032.launcher-ledger-identity.v2\0");
    digest.update(match stage {
        LedgerStage::SupervisorBeforeWorker => b"stage=supervisor-before-worker".as_slice(),
        LedgerStage::WorkerBeforeObserver => b"stage=worker-before-observer".as_slice(),
    });
    digest.update(b"\0header=");
    digest.update(header_hash.as_bytes());
    digest.update(b"\0payload=");
    digest.update(payload_hash.as_bytes());
    format!("{:x}", digest.finalize())
}

fn ledger_record_bytes(
    stage: LedgerStage,
    header_hash: &str,
    payload_hash: &str,
    identity: &str,
) -> Vec<u8> {
    serde_json::to_vec(&LedgerRecord {
        schema: "decadans.rm0032.native-observer-launcher-ledger-record.v2".into(),
        stage,
        envelope_header_sha256: header_hash.into(),
        observer_payload_sha256: payload_hash.into(),
        ledger_identity_sha256: identity.into(),
    })
    .expect("closed ledger record is serializable")
}

pub fn validate_canonical_observer_payload(bytes: &[u8]) -> Result<(), &'static str> {
    if bytes.is_empty() || bytes.len() > MAX_OBSERVER_PAYLOAD_BYTES || bytes.contains(&b'\n') {
        return Err("observer payload length or framing is invalid");
    }
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| "observer payload is not strict JSON")?;
    let object = value
        .as_object()
        .ok_or("observer payload is not a JSON object")?;
    let operation = object
        .get("operation")
        .and_then(serde_json::Value::as_str)
        .ok_or("observer payload operation is not a string")?;
    let expected_keys: &[&str] = match operation {
        "read-bound-file" => &[
            "schema",
            "version",
            "consumer",
            "operation",
            "requestId",
            "rootPath",
            "targetPath",
        ],
        "create-new-durable-file" => &[
            "schema",
            "version",
            "consumer",
            "operation",
            "requestId",
            "rootPath",
            "targetPath",
            "contentBase64",
        ],
        _ => return Err("observer payload operation is not admitted"),
    };
    if object.len() != expected_keys.len()
        || expected_keys.iter().any(|key| !object.contains_key(*key))
        || expected_keys.iter().any(|key| {
            object
                .get(*key)
                .and_then(serde_json::Value::as_str)
                .is_none()
        })
    {
        return Err("observer payload property set or field types are not exact");
    }
    if expected_keys.iter().any(|key| {
        object[*key].as_str().is_some_and(|text| {
            text.chars()
                .any(|character| matches!(character as u32, 0x00..=0x1f | 0x7f..=0x9f))
        })
    }) {
        return Err("observer payload contains a forbidden control scalar");
    }
    if object.get("schema").and_then(serde_json::Value::as_str) != Some(OBSERVER_REQUEST_SCHEMA)
        || object.get("version").and_then(serde_json::Value::as_str) != Some("v1")
        || object.get("consumer").and_then(serde_json::Value::as_str)
            != Some(OBSERVER_REQUEST_CONSUMER)
    {
        return Err("observer payload authority literals differ");
    }
    if serde_json::to_vec(&value).map_err(|_| "observer payload encoding failed")? != bytes {
        return Err("observer payload is not canonical JSON");
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProductionInvocationContext {
    pub mode: Mode,
    pub envelope: WireEnvelope,
    pub canonical_header_bytes: Vec<u8>,
    pub observer_payload_bytes: Vec<u8>,
    pub canonical_request_bytes: Vec<u8>,
    pub envelope_header_sha256: String,
    pub observer_payload_sha256: String,
    pub supervisor_ledger_identity_sha256: String,
    pub worker_ledger_identity_sha256: String,
    pub ledger_identity_sha256: String,
    pub supervisor_ledger_proof: Option<SupervisorLedgerProof>,
}

impl ProductionInvocationContext {
    pub fn new_supervisor(
        envelope: WireEnvelope,
        canonical_header_bytes: Vec<u8>,
        observer_payload_bytes: Vec<u8>,
    ) -> Result<Self, &'static str> {
        Self::from_parts(
            Mode::Supervisor,
            envelope,
            canonical_header_bytes,
            observer_payload_bytes,
            None,
        )
    }

    fn from_parts(
        mode: Mode,
        envelope: WireEnvelope,
        canonical_header_bytes: Vec<u8>,
        observer_payload_bytes: Vec<u8>,
        supervisor_ledger_proof: Option<SupervisorLedgerProof>,
    ) -> Result<Self, &'static str> {
        validate_wire_envelope(&envelope)?;
        if serde_json::to_vec(&envelope).map_err(|_| "header encoding failed")?
            != canonical_header_bytes
        {
            return Err("header bytes are not the bound canonical envelope");
        }
        validate_canonical_observer_payload(&observer_payload_bytes)?;
        let payload: serde_json::Value = serde_json::from_slice(&observer_payload_bytes)
            .map_err(|_| "observer payload binding parse failed")?;
        let payload = payload
            .as_object()
            .ok_or("observer payload binding is not an object")?;
        if payload.get("requestId").and_then(serde_json::Value::as_str)
            != Some(envelope.request_id.as_str())
        {
            return Err("observer payload requestId mismatches launcher header");
        }
        let envelope_header_sha256 = sha256_hex(&canonical_header_bytes);
        let observer_payload_sha256 = sha256_hex(&observer_payload_bytes);
        if envelope.stdin_byte_count != observer_payload_bytes.len() as u64
            || envelope.stdin_sha256 != observer_payload_sha256
        {
            return Err("observer payload byte count or SHA-256 mismatches header");
        }
        let supervisor_ledger_identity_sha256 = ledger_identity(
            LedgerStage::SupervisorBeforeWorker,
            &envelope_header_sha256,
            &observer_payload_sha256,
        );
        let worker_ledger_identity_sha256 = ledger_identity(
            LedgerStage::WorkerBeforeObserver,
            &envelope_header_sha256,
            &observer_payload_sha256,
        );
        if supervisor_ledger_identity_sha256 == worker_ledger_identity_sha256 {
            return Err("stage-separated ledger identities collided");
        }
        let ledger_identity_sha256 = match mode {
            Mode::Supervisor => supervisor_ledger_identity_sha256.clone(),
            Mode::Worker => worker_ledger_identity_sha256.clone(),
        };
        let mut context = Self {
            mode,
            envelope,
            canonical_header_bytes,
            observer_payload_bytes,
            canonical_request_bytes: Vec::new(),
            envelope_header_sha256,
            observer_payload_sha256,
            supervisor_ledger_identity_sha256,
            worker_ledger_identity_sha256,
            ledger_identity_sha256,
            supervisor_ledger_proof,
        };
        context.canonical_request_bytes = match mode {
            Mode::Supervisor => context.supervisor_handoff_bytes()?,
            Mode::Worker => context.observer_payload_bytes.clone(),
        };
        Ok(context)
    }

    pub fn ledger_record_bytes(&self, stage: LedgerStage) -> Vec<u8> {
        let identity = match stage {
            LedgerStage::SupervisorBeforeWorker => &self.supervisor_ledger_identity_sha256,
            LedgerStage::WorkerBeforeObserver => &self.worker_ledger_identity_sha256,
        };
        ledger_record_bytes(
            stage,
            &self.envelope_header_sha256,
            &self.observer_payload_sha256,
            identity,
        )
    }

    pub fn supervisor_proof(&self) -> SupervisorLedgerProof {
        SupervisorLedgerProof {
            schema: SUPERVISOR_LEDGER_PROOF_SCHEMA.into(),
            supervisor_ledger_identity_sha256: self.supervisor_ledger_identity_sha256.clone(),
            supervisor_ledger_record_sha256: sha256_hex(
                &self.ledger_record_bytes(LedgerStage::SupervisorBeforeWorker),
            ),
            envelope_header_sha256: self.envelope_header_sha256.clone(),
            observer_payload_sha256: self.observer_payload_sha256.clone(),
        }
    }

    pub fn supervisor_handoff_bytes(&self) -> Result<Vec<u8>, &'static str> {
        let proof = serde_json::to_vec(&self.supervisor_proof())
            .map_err(|_| "supervisor proof encoding failed")?;
        let mut bytes = Vec::with_capacity(
            self.canonical_header_bytes.len() + self.observer_payload_bytes.len() + proof.len() + 2,
        );
        bytes.extend_from_slice(&self.canonical_header_bytes);
        bytes.push(b'\n');
        bytes.extend_from_slice(&self.observer_payload_bytes);
        bytes.push(b'\n');
        bytes.extend_from_slice(&proof);
        if bytes.len() > MAX_HANDOFF_BYTES {
            return Err("supervisor handoff exceeds fixed cap");
        }
        Ok(bytes)
    }
}

pub fn parse_production_input(
    mode: Mode,
    bytes: &[u8],
) -> Result<ProductionInvocationContext, &'static str> {
    let expected_delimiters = if mode == Mode::Supervisor { 1 } else { 2 };
    if bytes.iter().filter(|byte| **byte == b'\n').count() != expected_delimiters {
        return Err("launcher input has invalid LF framing");
    }
    let mut parts = bytes.split(|byte| *byte == b'\n');
    let header_bytes = parts.next().ok_or("launcher header is absent")?.to_vec();
    let payload_bytes = parts.next().ok_or("observer payload is absent")?.to_vec();
    let envelope = parse_canonical_wire_envelope(&header_bytes)?;
    match mode {
        Mode::Supervisor => {
            if parts.next().is_some() {
                return Err("supervisor frame has trailing bytes");
            }
            ProductionInvocationContext::new_supervisor(envelope, header_bytes, payload_bytes)
        }
        Mode::Worker => {
            let proof_bytes = parts.next().ok_or("supervisor ledger proof is absent")?;
            if parts.next().is_some() {
                return Err("worker handoff has trailing bytes");
            }
            let proof: SupervisorLedgerProof = serde_json::from_slice(proof_bytes)
                .map_err(|_| "supervisor ledger proof is not strict JSON")?;
            if serde_json::to_vec(&proof).map_err(|_| "proof encoding failed")? != proof_bytes {
                return Err("supervisor ledger proof is not canonical JSON");
            }
            let context = ProductionInvocationContext::from_parts(
                mode,
                envelope,
                header_bytes,
                payload_bytes,
                Some(proof),
            )?;
            if context.supervisor_ledger_proof.as_ref() != Some(&context.supervisor_proof()) {
                return Err("supervisor ledger proof drifted from framed bytes");
            }
            Ok(context)
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum InvocationEvidenceKind {
    ChildNeverStarted,
    ChildStarted,
    ChildStartAmbiguous,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub enum EvidenceChildStarted {
    Known(bool),
    Unknown(String),
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EvidenceStdoutState {
    NotOpened,
    Eof,
    NotEofOrUnknown,
    CapExceededOrTruncated,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EvidenceStderrState {
    NotOpened,
    EofZeroBytes,
    NonzeroByteSeen,
    NotEofOrUnknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EvidenceStreamClosureState {
    NotOpened,
    BothEof,
    IncompleteOrUnknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, tag = "kind", rename_all = "kebab-case")]
pub enum EvidenceExitState {
    NotStarted,
    Known { code: i32 },
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LauncherWireEvidenceV1 {
    pub kind: InvocationEvidenceKind,
    pub invocation_attempt_count: u8,
    pub child_started: EvidenceChildStarted,
    pub captured_stdout_base64: String,
    pub captured_stderr_base64: String,
    pub stdout_state: EvidenceStdoutState,
    pub stderr_state: EvidenceStderrState,
    pub stream_closure_state: EvidenceStreamClosureState,
    pub exit_state: EvidenceExitState,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LauncherResult {
    pub schema: String,
    pub request_id: String,
    pub correlation_id: String,
    pub carrier_sha256: String,
    pub observer_image_sha256: String,
    pub stdin_sha256: String,
    pub deadline_ms: u64,
    pub ledger_identity_sha256: String,
    pub terminal: ReducerTerminal,
    pub reason: String,
    pub invocation_attempt_count: u8,
    pub child_start_evidence: ChildStartEvidence,
    pub child_started: String,
    pub ledger_state: String,
    pub sticky: bool,
    pub handles_released: bool,
    pub evidence: LauncherWireEvidenceV1,
}

pub fn validate_wire_evidence(
    evidence: &LauncherWireEvidenceV1,
) -> Result<(Vec<u8>, Vec<u8>), &'static str> {
    if evidence.invocation_attempt_count != 1 {
        return Err("wire evidence invocation count differs");
    }
    let decode = |encoded: &str, cap: usize| -> Result<Vec<u8>, &'static str> {
        if !encoded.len().is_multiple_of(4) {
            return Err("wire evidence Base64 length differs");
        }
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|_| "wire evidence Base64 is invalid")?;
        if bytes.len() > cap || STANDARD.encode(&bytes) != encoded {
            return Err("wire evidence Base64 is noncanonical or exceeds cap");
        }
        Ok(bytes)
    };
    let stdout = decode(&evidence.captured_stdout_base64, MAX_STDOUT_BYTES)?;
    let stderr = decode(&evidence.captured_stderr_base64, MAX_STDERR_BYTES)?;
    let closure_consistent = evidence.stream_closure_state != EvidenceStreamClosureState::BothEof
        || (evidence.stdout_state == EvidenceStdoutState::Eof
            && evidence.stderr_state == EvidenceStderrState::EofZeroBytes);
    let branch_consistent = match evidence.kind {
        InvocationEvidenceKind::ChildNeverStarted => {
            evidence.child_started == EvidenceChildStarted::Known(false)
                && stdout.is_empty()
                && stderr.is_empty()
                && evidence.stdout_state == EvidenceStdoutState::NotOpened
                && evidence.stderr_state == EvidenceStderrState::NotOpened
                && evidence.stream_closure_state == EvidenceStreamClosureState::NotOpened
                && evidence.exit_state == EvidenceExitState::NotStarted
        }
        InvocationEvidenceKind::ChildStarted => {
            evidence.child_started == EvidenceChildStarted::Known(true)
                && evidence.stdout_state != EvidenceStdoutState::NotOpened
                && evidence.stderr_state != EvidenceStderrState::NotOpened
                && evidence.stream_closure_state != EvidenceStreamClosureState::NotOpened
                && !matches!(evidence.exit_state, EvidenceExitState::NotStarted)
                && stderr.is_empty()
                && closure_consistent
        }
        InvocationEvidenceKind::ChildStartAmbiguous => {
            evidence.child_started == EvidenceChildStarted::Unknown("unknown".into())
                && stderr.is_empty()
                && closure_consistent
        }
    };
    if !branch_consistent {
        return Err("wire evidence branch/state combination is contradictory");
    }
    Ok((stdout, stderr))
}

pub fn conservative_wire_evidence(child: ChildStartEvidence) -> LauncherWireEvidenceV1 {
    match child {
        ChildStartEvidence::NeverStarted => LauncherWireEvidenceV1 {
            kind: InvocationEvidenceKind::ChildNeverStarted,
            invocation_attempt_count: 1,
            child_started: EvidenceChildStarted::Known(false),
            captured_stdout_base64: String::new(),
            captured_stderr_base64: String::new(),
            stdout_state: EvidenceStdoutState::NotOpened,
            stderr_state: EvidenceStderrState::NotOpened,
            stream_closure_state: EvidenceStreamClosureState::NotOpened,
            exit_state: EvidenceExitState::NotStarted,
        },
        ChildStartEvidence::Started => LauncherWireEvidenceV1 {
            kind: InvocationEvidenceKind::ChildStarted,
            invocation_attempt_count: 1,
            child_started: EvidenceChildStarted::Known(true),
            captured_stdout_base64: String::new(),
            captured_stderr_base64: String::new(),
            stdout_state: EvidenceStdoutState::NotEofOrUnknown,
            stderr_state: EvidenceStderrState::NotEofOrUnknown,
            stream_closure_state: EvidenceStreamClosureState::IncompleteOrUnknown,
            exit_state: EvidenceExitState::Unknown,
        },
        ChildStartEvidence::Ambiguous => LauncherWireEvidenceV1 {
            kind: InvocationEvidenceKind::ChildStartAmbiguous,
            invocation_attempt_count: 1,
            child_started: EvidenceChildStarted::Unknown("unknown".into()),
            captured_stdout_base64: String::new(),
            captured_stderr_base64: String::new(),
            stdout_state: EvidenceStdoutState::NotOpened,
            stderr_state: EvidenceStderrState::NotOpened,
            stream_closure_state: EvidenceStreamClosureState::NotOpened,
            exit_state: EvidenceExitState::NotStarted,
        },
    }
}

pub fn parse_canonical_launcher_result(bytes: &[u8]) -> Result<LauncherResult, &'static str> {
    if bytes.is_empty() || bytes.len() > MAX_WORKER_RESULT_BYTES {
        return Err("launcher result wire length differs");
    }
    let result: LauncherResult =
        serde_json::from_slice(bytes).map_err(|_| "launcher result wire is not strict JSON")?;
    if serde_json::to_vec(&result).map_err(|_| "launcher result encoding failed")? != bytes {
        return Err("launcher result wire is not canonical JSON");
    }
    validate_wire_evidence(&result.evidence)?;
    if result.schema != RESULT_SCHEMA || result.invocation_attempt_count != 1 {
        return Err("launcher result schema or invocation count differs");
    }
    Ok(result)
}

pub fn validate_observer_stdout_framing(bytes: &[u8]) -> bool {
    if bytes.is_empty() || bytes.len() > MAX_STDOUT_BYTES {
        return bytes.is_empty();
    }
    let parts: Vec<&[u8]> = bytes.split(|byte| *byte == b'\n').collect();
    if !(parts.len() == 1 || parts.len() == 2) || parts.iter().any(|part| part.is_empty()) {
        return false;
    }
    parts.iter().all(|part| {
        serde_json::from_slice::<serde_json::Value>(part)
            .ok()
            .and_then(|value| serde_json::to_vec(&value).ok())
            .is_some_and(|canonical| canonical == *part)
    })
}

fn promote_worker_result(
    supervisor: &ProductionInvocationContext,
    bytes: &[u8],
) -> Result<LauncherResult, &'static str> {
    promote_worker_result_observed(supervisor, bytes, &mut WorkerPromotionDiagnostic::default())
}

// Diagnostic observations are not promotion evidence. In particular, a bound
// worker failure remains rejected by the existing terminal-tuple policy.
macro_rules! io_diagnostic_enum {
    ($name:ident { $($variant:ident),+ }) => {
        #[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
        #[serde(rename_all = "kebab-case")]
        pub enum $name { $($variant),+ }
    };
}
io_diagnostic_enum!(IoStopOrigin { IoStart, StdinTransfer, StdoutTransfer, StderrTransfer,
    ProcessStillActive, ProcessDeadline, ProcessExit, ProcessIdentity, DeadlineTie });
io_diagnostic_enum!(IoCleanupOutcome { Ok, Refused, Failed, Unknown, Unexpected });
io_diagnostic_enum!(IoDiagnosticStream { Stdin, Stdout, Stderr });
io_diagnostic_enum!(IoDiagnosticDirection { Read, Write });
io_diagnostic_enum!(IoDiagnosticApi { ReadSubmit, WriteSubmit, Completion, Wait, Cancel });
io_diagnostic_enum!(IoDiagnosticState { Prepared, Pending, Immediate, Terminal,
    TerminalError, InitialWriteNoData, CancelRequested, Retired });

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IoNativeDiagnostic {
    pub stream: IoDiagnosticStream,
    pub direction: IoDiagnosticDirection,
    pub api: IoDiagnosticApi,
    pub state: IoDiagnosticState,
    pub code: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IoStopDiagnostic {
    pub origin: IoStopOrigin,
    pub cleanup: [IoCleanupOutcome; 4],
    pub io: Option<IoNativeDiagnostic>,
    pub exit_before: Option<u32>,
    pub exit_after: Option<u32>,
}

impl IoStopOrigin {
    fn from_reason(reason: &str) -> Option<Self> {
        Some(match reason {
            "concurrent overlapped I/O start failed" => Self::IoStart,
            "stdin broke before every byte completed" => Self::StdinTransfer,
            "stdout was not bounded canonical EOF" => Self::StdoutTransfer,
            "stderr was nonzero or not EOF" => Self::StderrTransfer,
            "process remained STILL_ACTIVE" => Self::ProcessStillActive,
            "process did not exit before deadline" => Self::ProcessDeadline,
            "process exit was ambiguous" => Self::ProcessExit,
            "signaled process did not match the launched process" => Self::ProcessIdentity,
            "deadline won the terminal tie" => Self::DeadlineTie,
            _ => return None,
        })
    }
}

fn io_cleanup_outcome(reply: &KernelReply) -> IoCleanupOutcome {
    match reply {
        KernelReply::Ok | KernelReply::CancelRaceRetained => IoCleanupOutcome::Ok,
        KernelReply::Refused(_) => IoCleanupOutcome::Refused,
        KernelReply::Failed(_) => IoCleanupOutcome::Failed,
        KernelReply::Unknown(_) => IoCleanupOutcome::Unknown,
        _ => IoCleanupOutcome::Unexpected,
    }
}

pub fn parse_io_stop_reason(reason: &str) -> Option<(&str, IoStopDiagnostic)> {
    if reason.len() > 768 { return None; }
    let (prefix, encoded) = reason.split_once("; io-stop=")?;
    let value: IoStopDiagnostic = serde_json::from_str(encoded).ok()?;
    if serde_json::to_string(&value).ok()? != encoded { return None; }
    if let Some(io) = value.io {
        let expected_direction = if io.stream == IoDiagnosticStream::Stdin {
            IoDiagnosticDirection::Write
        } else { IoDiagnosticDirection::Read };
        if io.direction != expected_direction
            || (io.api == IoDiagnosticApi::ReadSubmit && io.direction != IoDiagnosticDirection::Read)
            || (io.api == IoDiagnosticApi::WriteSubmit && io.direction != IoDiagnosticDirection::Write)
            || (io.state == IoDiagnosticState::InitialWriteNoData
                && (io.api != IoDiagnosticApi::WriteSubmit || io.code != 232)) {
            return None;
        }
    }
    let any_cleanup_failure = value.cleanup.iter().any(|v| *v != IoCleanupOutcome::Ok);
    if prefix == "terminal I/O cleanup or reap is ambiguous" {
        if !any_cleanup_failure { return None; }
    } else if IoStopOrigin::from_reason(prefix) != Some(value.origin) || any_cleanup_failure {
        return None;
    }
    Some((prefix, value))
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum WorkerPromotionDiagnostic {
    #[default]
    EofNotObserved,
    ContextRejected,
    MalformedFrame,
    CorrelationMismatch,
    StructuralTupleRejected,
    TerminalTupleRejected { worker_category: &'static str },
    IoStopRejected { worker_category: &'static str, diagnostic: IoStopDiagnostic },
    Validated,
}

impl WorkerPromotionDiagnostic {
    fn label(self) -> &'static str {
        match self {
            Self::EofNotObserved => "eof-not-observed",
            Self::ContextRejected => "context-rejected",
            Self::MalformedFrame => "malformed-frame",
            Self::CorrelationMismatch => "correlation-mismatch",
            Self::StructuralTupleRejected => "structural-tuple-rejected",
            Self::TerminalTupleRejected { .. } | Self::IoStopRejected { .. } => "terminal-tuple-rejected",
            Self::Validated => "validated",
        }
    }
}

// Exact allowlist only: never interpolate a worker-supplied reason, path,
// environment value, or even a prefix/suffix of an unrecognized reason.
fn bounded_failure_category(reason: &str) -> &'static str {
    if let Some((prefix, _)) = parse_io_stop_reason(reason) {
        return bounded_failure_category(prefix);
    }
    match reason {
        "bounded fixed launcher invocation succeeded" => "success",
        "worker was not assigned to outer job" => "worker-outer-assignment",
        "outer containment verification failed" => "worker-outer-confinement",
        "worker outer membership verification failed" => "worker-outer-membership",
        "worker launcher image reverify failed" => "worker-image-reverify",
        "observer was not assigned to inner job" => "observer-inner-assignment",
        "observer confinement verification failed" => "observer-confinement",
        "observer token and job confinement verification failed" => "observer-token-job-confinement",
        "observer outer membership verification failed" => "observer-outer-membership",
        "observer image reverify failed" => "observer-image-reverify",
        "observer surface reverify failed" => "observer-surface-reverify",
        "worker resume count was not exactly one" => "worker-resume-count",
        "observer resume count was not exactly one" => "observer-resume-count",
        "sampled worker thread limit exceeded or was ambiguous" => "worker-thread-sample",
        "sampled observer thread limit exceeded or was ambiguous" => "observer-thread-sample",
        "concurrent overlapped I/O start failed" => "io-start",
        "stdin broke before every byte completed" => "stdin-transfer",
        "stdout was not bounded canonical EOF" => "stdout-transfer",
        "stderr was nonzero or not EOF" => "stderr-transfer",
        "process remained STILL_ACTIVE" => "process-still-active",
        "process did not exit before deadline" => "process-deadline",
        "process exit was ambiguous" => "process-exit",
        "signaled process did not match the launched process" => "process-identity",
        "deadline won the terminal tie" => "deadline-tie",
        "pre-assignment termination or reap is ambiguous" => "pre-assignment-cleanup",
        "assigned child terminal cleanup is ambiguous" => "assigned-cleanup",
        "terminal I/O cleanup or reap is ambiguous" => "io-cleanup",
        "ambiguous reap or final identity/evidence state" => "final-evidence-or-release",
        _ => "redacted",
    }
}

fn promote_worker_result_observed(
    supervisor: &ProductionInvocationContext,
    bytes: &[u8],
    diagnostic: &mut WorkerPromotionDiagnostic,
) -> Result<LauncherResult, &'static str> {
    *diagnostic = WorkerPromotionDiagnostic::ContextRejected;
    if supervisor.mode != Mode::Supervisor {
        return Err("worker result promotion requires supervisor context");
    }
    *diagnostic = WorkerPromotionDiagnostic::MalformedFrame;
    let result = parse_canonical_launcher_result(bytes)?;
    *diagnostic = WorkerPromotionDiagnostic::CorrelationMismatch;
    if result.request_id != supervisor.envelope.request_id
        || result.correlation_id != supervisor.envelope.correlation_id
        || result.carrier_sha256 != supervisor.envelope.carrier_sha256
        || result.observer_image_sha256 != supervisor.envelope.observer_image_sha256
        || result.stdin_sha256 != supervisor.envelope.stdin_sha256
        || result.deadline_ms != supervisor.envelope.deadline_ms
        || result.ledger_identity_sha256 != supervisor.worker_ledger_identity_sha256
    {
        return Err("worker launcher result binding or correlation differs");
    }
    let expected_outer = match result.evidence.kind {
        InvocationEvidenceKind::ChildNeverStarted => (ChildStartEvidence::NeverStarted, "false"),
        InvocationEvidenceKind::ChildStarted => (ChildStartEvidence::Started, "true"),
        InvocationEvidenceKind::ChildStartAmbiguous => (ChildStartEvidence::Ambiguous, "unknown"),
    };
    *diagnostic = WorkerPromotionDiagnostic::StructuralTupleRejected;
    if result.child_start_evidence != expected_outer.0
        || result.child_started != expected_outer.1
        || result.evidence.invocation_attempt_count != result.invocation_attempt_count
    {
        return Err("worker launcher outer, nested, or terminal tuple differs");
    }
    // Only after canonical framing, full context correlation and outer/nested
    // structural agreement may the fixed diagnostic vocabulary describe it.
    *diagnostic = WorkerPromotionDiagnostic::TerminalTupleRejected {
        worker_category: bounded_failure_category(&result.reason),
    };
    if let Some((prefix, value)) = parse_io_stop_reason(&result.reason) {
        *diagnostic = WorkerPromotionDiagnostic::IoStopRejected {
            worker_category: bounded_failure_category(prefix), diagnostic: value,
        };
    }
    if !worker_result_tuple_is_coherent(&result) {
        return Err("worker launcher outer, nested, or terminal tuple differs");
    }
    *diagnostic = WorkerPromotionDiagnostic::Validated;
    Ok(result)
}

pub fn promote_worker_evidence(
    supervisor: &ProductionInvocationContext,
    bytes: &[u8],
) -> Result<LauncherWireEvidenceV1, &'static str> {
    promote_worker_result(supervisor, bytes).map(|result| result.evidence)
}

fn worker_result_tuple_is_coherent(result: &LauncherResult) -> bool {
    if result.reason.is_empty()
        || result.reason.len() > 1_024
        || !matches!(
            result.ledger_state.as_str(),
            "unattempted" | "durable-consumed" | "sticky-collision" | "sticky-unknown"
        )
    {
        return false;
    }
    let sticky_ledger = matches!(
        result.ledger_state.as_str(),
        "sticky-collision" | "sticky-unknown"
    );
    match result.child_start_evidence {
        ChildStartEvidence::Started => {
            result.terminal == ReducerTerminal::Success
                && result.reason == "bounded fixed launcher invocation succeeded"
                && result.ledger_state == "durable-consumed"
                && !result.sticky
                && result.handles_released
        }
        ChildStartEvidence::NeverStarted => {
            sticky_ledger == result.sticky
                && !result.handles_released
                && result.terminal != ReducerTerminal::Success
                && result.terminal != ReducerTerminal::Quarantined
        }
        ChildStartEvidence::Ambiguous => {
            sticky_ledger == result.sticky
                && !result.handles_released
                && matches!(
                    result.terminal,
                    ReducerTerminal::Unknown
                        | ReducerTerminal::Deadline
                        | ReducerTerminal::Quarantined
                )
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct JobLimits {
    pub active_process_limit: u32,
    pub process_memory_bytes: u64,
    pub job_memory_bytes: u64,
    pub cpu_rate_percent: u32,
    pub kill_on_close: bool,
    pub breakaway_allowed: bool,
    pub inheritable: bool,
}

pub const OUTER_JOB_LIMITS: JobLimits = JobLimits {
    active_process_limit: OUTER_ACTIVE_PROCESS_LIMIT,
    process_memory_bytes: PROCESS_MEMORY_LIMIT_BYTES,
    job_memory_bytes: JOB_MEMORY_LIMIT_BYTES,
    cpu_rate_percent: CPU_RATE_PERCENT,
    kill_on_close: true,
    breakaway_allowed: false,
    inheritable: false,
};

pub const INNER_JOB_LIMITS: JobLimits = JobLimits {
    active_process_limit: INNER_ACTIVE_PROCESS_LIMIT,
    ..OUTER_JOB_LIMITS
};

pub const TOKEN_RIGHTS: u32 = 0x0002 | 0x0008 | 0x0001 | 0x0080;
pub const REQUIRED_TOKEN_RIGHTS_DESCRIPTION: &str =
    "TOKEN_DUPLICATE|TOKEN_QUERY|TOKEN_ASSIGN_PRIMARY|TOKEN_ADJUST_DEFAULT";
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RestrictedTokenPolicy {
    pub flags: u32,
    pub delete_every_enumerated_source_privilege: bool,
    pub require_post_restriction_privilege_count_zero: bool,
    pub preserve_existing_standard_groups_and_enabled_notify: bool,
}
pub const RESTRICTED_TOKEN_POLICY: RestrictedTokenPolicy = RestrictedTokenPolicy {
    flags: 0,
    delete_every_enumerated_source_privilege: false,
    require_post_restriction_privilege_count_zero: false,
    preserve_existing_standard_groups_and_enabled_notify: true,
};
pub const EXACT_ENVIRONMENT_KEYS: [&str; 3] = ["SystemDrive", "SystemRoot", "WINDIR"];

pub const OBSERVER_DRIVE_BINDING_KEY: &str = "DECADANS_OBSERVER_DRIVE_BINDING_V1";
pub const OBSERVER_DRIVE_BINDING_SCHEMA: &str = "decadans.rm0032.observer-drive-binding.v1";
pub const DRIVE_BINDING_FAILURE: &str = "observer drive binding finalization failed";

// This is a copy of the Observer's input grammar, cross-checked against its
// actual parser by the owning vectors. No privileged open precedes this check.
pub fn validate_drive_binding_paths(root: &str, target: &str) -> Result<String, &'static str> {
    fn parse(path: &str) -> Result<(u8, Vec<&str>), &'static str> {
        if path.len() < 3 || path.len() > 1024 || path.contains('/')
            || !path.as_bytes()[0].is_ascii_uppercase()
            || path.as_bytes()[1..3] != *b":\\"
            || path.chars().any(|c| matches!(c as u32, 0..=31 | 127..=159))
        { return Err("drive binding DOS path refused"); }
        let parts: Vec<&str> = if path.len() == 3 { Vec::new() } else { path[3..].split('\\').collect() };
        for part in &parts {
            if part.is_empty() || *part == "." || *part == ".."
                || part.contains([':', '<', '>', '"', '|', '?', '*'])
                || part.ends_with(['.', ' '])
            { return Err("drive binding path component refused"); }
            let stem = part.split('.').next().unwrap_or(part).to_ascii_uppercase();
            let number = stem.strip_prefix("COM").or_else(|| stem.strip_prefix("LPT"));
            if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$" | "CONIN$" | "CONOUT$")
                || number.is_some_and(|suffix| {
                    let mut chars = suffix.chars();
                    matches!(chars.next(), Some('1'..='9' | '¹' | '²' | '³')) && chars.next().is_none()
                })
            { return Err("drive binding reserved path component"); }
        }
        Ok((path.as_bytes()[0], parts))
    }
    let (drive, roots) = parse(root)?;
    let (target_drive, targets) = parse(target)?;
    if drive != target_drive || targets.len() <= roots.len()
        || roots.iter().zip(&targets).any(|(a,b)| a.as_bytes() != b.as_bytes())
    { return Err("drive binding path pair refused"); }
    Ok(format!("{}:", char::from(drive)))
}

pub fn drive_binding_request(context: &ProductionInvocationContext) -> Result<(String, String), &'static str> {
    if context.mode != Mode::Worker
        || context.canonical_request_bytes != context.observer_payload_bytes
        || sha256_hex(&context.observer_payload_bytes) != context.observer_payload_sha256
        || context.envelope.stdin_sha256 != context.observer_payload_sha256
        || context.envelope.stdin_byte_count != context.observer_payload_bytes.len() as u64
    { return Err("drive binding payload context differs"); }
    validate_canonical_observer_payload(&context.observer_payload_bytes)?;
    let payload: serde_json::Value = serde_json::from_slice(&context.observer_payload_bytes)
        .map_err(|_| "drive binding request parse failed")?;
    if payload["requestId"].as_str() != Some(context.envelope.request_id.as_str()) {
        return Err("drive binding request identity differs");
    }
    let drive = validate_drive_binding_paths(
        payload["rootPath"].as_str().ok_or("drive binding root absent")?,
        payload["targetPath"].as_str().ok_or("drive binding target absent")?,
    )?;
    Ok((drive, context.observer_payload_sha256.clone()))
}

fn valid_nt_volume_root(value: &str) -> bool {
    value.is_ascii() && value.len() <= 512
        && value.strip_prefix(r"\Device\HarddiskVolume")
            .and_then(|tail| tail.strip_suffix('\\'))
            .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DriveAnchorObservation {
    pub normalized_dos: String,
    pub normalized_nt: String,
    pub volume_serial: u64,
    pub file_id: [u8; 16],
    pub directory: bool,
    pub delete_pending: bool,
    pub reparse: bool,
}

// Private fields prevent a caller string from becoming a generated binding.
#[derive(Clone)]
pub struct GeneratedDriveBinding {
    drive: String,
    request_sha256: String,
    record: String,
}
impl GeneratedDriveBinding {
    pub fn canonical_record(&self) -> &str { &self.record }
    fn from_observation(drive: &str, hash: &str, observed: &DriveAnchorObservation)
        -> Result<Self, &'static str>
    {
        if drive.len() != 2 || !drive.as_bytes()[0].is_ascii_uppercase() || drive.as_bytes()[1] != b':'
            || !exact_lower_sha256(hash)
            || observed.normalized_dos != format!(r"\\?\{drive}\")
            || !valid_nt_volume_root(&observed.normalized_nt)
            || !observed.directory || observed.delete_pending || observed.reparse
        { return Err("drive binding anchor readback refused"); }
        let record = serde_json::to_string(&serde_json::json!({
            "drive": drive, "ntVolumeRoot": observed.normalized_nt,
            "requestSha256": hash, "schema": OBSERVER_DRIVE_BINDING_SCHEMA,
            "volumeSerialNumber": format!("{:016x}", observed.volume_serial)
        })).map_err(|_| "drive binding encoding failed")?;
        if !record.is_ascii() || record.len() > 1024 || record.encode_utf16().count() > 1024 {
            return Err("drive binding encoding exceeds bound");
        }
        Ok(Self { drive: drive.into(), request_sha256: hash.into(), record })
    }
}

pub trait DriveAnchorProvider {
    type Handle;
    fn drive_type(&mut self, exact_drive_root: &str) -> Result<u32, &'static str>;
    fn open(&mut self, exact_drive_root: &str) -> Result<Self::Handle, &'static str>;
    fn observe(&mut self, handle: &Self::Handle) -> Result<DriveAnchorObservation, &'static str>;
    // Consumes ownership even on an ambiguous close; never retry a numeric handle.
    fn close(&mut self, handle: Self::Handle) -> Result<(), &'static str>;
}

pub struct HeldDriveBinding<H> {
    handle: Option<H>,
    initial: Option<DriveAnchorObservation>,
    generated: Option<GeneratedDriveBinding>,
    attempted: bool,
    failed: bool,
    finalized: bool,
}
impl<H> Default for HeldDriveBinding<H> {
    fn default() -> Self {
        Self { handle: None, initial: None, generated: None, attempted: false, failed: false, finalized: false }
    }
}
impl<H> HeldDriveBinding<H> {
    pub fn acquire<P: DriveAnchorProvider<Handle=H>>(&mut self, provider: &mut P,
        context: &ProductionInvocationContext) -> Result<(), &'static str>
    {
        if self.attempted || self.finalized { self.failed = true; return Err("drive binding acquisition repeated"); }
        self.attempted = true;
        let result = (|| {
            let (drive, hash) = drive_binding_request(context)?;
            if provider.drive_type(&format!("{drive}\\"))? != 3 {
                return Err("drive binding requires fixed local drive");
            }
            self.handle = Some(provider.open(&format!(r"\\?\{drive}\"))?);
            let observed = provider.observe(self.handle.as_ref().ok_or("drive anchor absent")?)?;
            let generated = GeneratedDriveBinding::from_observation(&drive, &hash, &observed)?;
            self.initial = Some(observed);
            self.generated = Some(generated);
            Ok(())
        })();
        if result.is_err() { self.failed = true; }
        result
    }
    pub fn generated(&self, context: &ProductionInvocationContext) -> Result<&GeneratedDriveBinding, &'static str> {
        let (drive, hash) = drive_binding_request(context)?;
        let generated = self.generated.as_ref().ok_or("drive binding not generated")?;
        if self.failed || self.finalized || self.handle.is_none()
            || generated.drive != drive || generated.request_sha256 != hash
        { return Err("drive binding generated context differs"); }
        Ok(generated)
    }
    pub fn revalidate<P: DriveAnchorProvider<Handle=H>>(&mut self, provider: &mut P) -> Result<(), &'static str> {
        let result = (|| {
            if self.failed || self.finalized { return Err("drive binding guard is not live"); }
            let observed = provider.observe(self.handle.as_ref().ok_or("drive anchor absent")?)?;
            if self.initial.as_ref() != Some(&observed) { return Err("drive binding anchor changed"); }
            Ok(())
        })();
        if result.is_err() { self.failed = true; }
        result
    }
    pub fn finish<P: DriveAnchorProvider<Handle=H>>(&mut self, provider: &mut P) -> Result<(), &'static str> {
        if self.finalized { return if self.failed { Err(DRIVE_BINDING_FAILURE) } else { Ok(()) }; }
        // Even acquisition/recheck failure retains an opened owner until this
        // terminal cleanup. A failed guard cannot be rehabilitated by closing.
        if self.handle.is_some() && !self.failed && self.revalidate(provider).is_err() { self.failed = true; }
        if let Some(handle) = self.handle.take() {
            if provider.close(handle).is_err() { self.failed = true; }
        }
        self.finalized = true;
        if self.failed { Err(DRIVE_BINDING_FAILURE) } else { Ok(()) }
    }
}

// Shared acquisition/evaluation seam. Identity values stay in memory, never diagnostics.
pub const OBSERVER_STANDARD_GROUPS: [&str; 3] = ["S-1-5-32-545", "S-1-1-0", "S-1-5-11"];
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObserverTokenSnapshot {
    pub user: String,
    pub groups: Vec<(String, u32)>,
    pub privileges: Vec<((u32, i32), u32)>,
    pub integrity: String,
    pub integrity_attributes: u32,
    pub token_type: i32,
}
pub fn observer_expected_token(source: &ObserverTokenSnapshot, notify: (u32, i32), low: bool)
    -> Result<ObserverTokenSnapshot, &'static str>
{
    if source.user.is_empty() || source.token_type != 1 || source.integrity_attributes != 96
        || !source.integrity.starts_with("S-1-16-")
        || source.groups.is_empty() || source.groups.len() > 4096 || source.privileges.len() > 4096
        || source.groups.iter().enumerate().any(|(i, (sid, _))|
            source.groups[i + 1..].iter().any(|(other, _)| other == sid))
        || source.privileges.iter().enumerate().any(|(i, (luid, _))|
            source.privileges[i + 1..].iter().any(|(other, _)| other == luid))
    { return Err("observer source token shape refused"); }
    if !OBSERVER_STANDARD_GROUPS.iter().all(|required| source.groups.iter()
        .any(|(sid, flags)| sid == required && flags & 4 != 0 && flags & 16 == 0))
    { return Err("observer source standard group prerequisite absent"); }
    let rights: Vec<_> = source.privileges.iter().copied().filter(|(luid, _)| *luid == notify).collect();
    if rights.len() != 1 || rights[0].1 & 2 == 0 || rights[0].1 & !3 != 0 {
        return Err("observer source enabled traversal privilege absent");
    }
    let mut integrity_count = 0;
    let mut logon_count = 0;
    let mut expected = source.clone();
    expected.privileges = rights;
    for (sid, flags) in &mut expected.groups {
        if *sid == source.integrity {
            if *flags != 96 { return Err("observer source integrity group mismatch"); }
            integrity_count += 1;
            if low { *sid = "S-1-16-4096".into(); }
        } else if *flags & 0xC000_0000 != 0 {
            if *flags & 0xC000_0000 != 0xC000_0000 || !sid.starts_with("S-1-5-5-") {
                return Err("observer source logon group mismatch");
            }
            logon_count += 1;
        } else if *flags & 96 != 0 {
            return Err("observer source unexpected integrity group");
        } else if *flags & 4 != 0 && *flags & 16 == 0
            && !OBSERVER_STANDARD_GROUPS.contains(&sid.as_str()) && *sid != source.user
        {
            *flags = 16;
        } else if *flags & 4 != 0 && *flags & 16 != 0 {
            return Err("observer source enabled deny-only group refused");
        }
    }
    if integrity_count != 1 || logon_count > 1 { return Err("observer source identity groups refused"); }
    if low { expected.integrity = "S-1-16-4096".into(); }
    if expected.groups.iter().enumerate().any(|(i, (sid, _))|
        expected.groups[i + 1..].iter().any(|(other, _)| other == sid))
    { return Err("observer low integrity replacement aliases a group"); }
    Ok(expected)
}
pub fn verify_observer_token_transform(source: &ObserverTokenSnapshot, notify: (u32, i32), low: bool,
    acquire: impl FnOnce() -> Result<ObserverTokenSnapshot, &'static str>) -> Result<(), &'static str>
{
    let mut expected = observer_expected_token(source, notify, low)?;
    let mut actual = acquire()?;
    expected.groups.sort(); actual.groups.sort();
    expected.privileges.sort(); actual.privileges.sort();
    if actual != expected { return Err("observer token source-relative readback refused"); }
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ObserverReadRole { Image, Cwd }
pub fn verify_observer_startup_binding(kind: ChildKind, flags: u32, cwd: &str) -> Result<(), &'static str> {
    let (expected_flags, expected_cwd) = match kind {
        ChildKind::Observer => (0x0008_040C, FIXED_OBSERVER_CWD),
        ChildKind::Worker => (0x0808_0404, FIXED_CWD),
    };
    if flags != expected_flags || cwd != expected_cwd {
        return Err("native child role startup binding refused");
    }
    Ok(())
}
pub const OBSERVER_READ_MASK: u32 = 0x0012_00A9;
pub const OBSERVER_MAINTENANCE_MASK: u32 = 0x001F_01FF;
#[derive(Clone, Debug)]
pub struct ObserverReadSecurity {
    pub protected: bool,
    pub dacl_present: bool,
    pub owner: String,
    pub group: String,
    pub aces: Vec<(u8, u8, u32, String)>,
}
pub fn verify_observer_read_security(role: ObserverReadRole, actual_directory: bool,
    user: &str, package: &str, security: &ObserverReadSecurity) -> Result<(), &'static str>
{
    let principals = ["S-1-5-18", "S-1-5-32-544", user, package];
    if (role == ObserverReadRole::Cwd) != actual_directory || !security.protected
        || !security.dacl_present || security.owner != "S-1-5-32-544" || security.group != "S-1-5-32-544"
        || user.is_empty() || package.is_empty() || security.aces.len() != 4
        || principals.iter().enumerate().any(|(i, sid)| principals[i + 1..].contains(sid))
    { return Err("observer read-only descriptor shape refused"); }
    for (i, principal) in principals.iter().enumerate() {
        let mask = if i < 2 { OBSERVER_MAINTENANCE_MASK } else { OBSERVER_READ_MASK };
        if security.aces.iter().filter(|(kind, flags, access, sid)|
            *kind == 0 && *flags == 0 && *access == mask && sid == principal).count() != 1
        { return Err("observer read-only descriptor ACE refused"); }
    }
    Ok(())
}

#[cfg(all(windows, test))]
pub mod native_observer_startup_fixture {
    use super::*;
    pub fn copied_token_and_descriptor_readbacks() {
        // Query/duplicate only: never adjusts the source token or creates a process/profile.
        let mut raw = null_mut();
        assert_ne!(unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &mut raw) }, 0);
        let source = OwnedNativeHandle::new(raw, TypedHandleKind::Token).unwrap();
        let before = native_observer_token_snapshot(source.raw()).unwrap();
        let primary = native_create_restricted_primary(source.raw()).unwrap();
        let notify = native_observer_notify_luid().unwrap();
        assert!(verify_observer_token_transform(&before, notify, false,
            || native_observer_token_snapshot(primary.raw())).is_ok());
        native_set_low_integrity(primary.raw()).unwrap();
        assert!(native_verify_restricted_primary(source.raw(), primary.raw()).is_ok());
        assert!(native_observer_token_snapshot(source.raw()).unwrap() == before);
        assert!(native_observer_token_snapshot(null_mut()).is_err());
        assert!(observer_buffer_value::<TOKEN_USER>(&[0; 4], 0).is_err());
        assert!(observer_buffer_sid(&[0; 8], null_mut()).is_err());

        let package_name = "S-1-15-2-1234";
        let sddl = format!("O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1200a9;;;{})(A;;0x1200a9;;;{})", before.user, package_name);
        let mut descriptor = null_mut();
        assert_ne!(unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(wide(&sddl).as_ptr(),
            1, &mut descriptor, null_mut()) }, 0);
        let held = OwnedLocalAllocation(descriptor);
        let security = native_observer_read_descriptor(held.0).unwrap();
        assert!(verify_observer_read_security(ObserverReadRole::Image, false, &before.user, package_name, &security).is_ok());
        assert!(verify_observer_read_security(ObserverReadRole::Cwd, true, &before.user, package_name, &security).is_ok());
        assert!(verify_observer_read_security(ObserverReadRole::Cwd, false, &before.user, package_name, &security).is_err());
        assert!(native_observer_read_descriptor(null_mut()).is_err());
        println!("NATIVE_OBSERVER_STARTUP_COMPATIBILITY token=true low=true source_unchanged=true descriptor=true invalid_acquisition_refused=true");
    }
}
pub const EXACT_ENVIRONMENT: [(&str, &str); 3] = [
    ("SystemDrive", "C:"),
    ("SystemRoot", EXACT_WINDOWS_ROOT),
    ("WINDIR", EXACT_WINDOWS_ROOT),
];

#[cfg(windows)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FixedNativeLaunchSpec {
    pub application: &'static str,
    pub mode: &'static str,
    pub cwd: &'static str,
    pub creation_flags: u32,
    pub startup_info_flags: u32,
    pub inherited_handle_count: usize,
    pub inherit_handles: bool,
    pub attribute_count: u32,
}

#[cfg(windows)]
pub const FIXED_NATIVE_CREATION_FLAGS: u32 =
    CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT;
#[cfg(windows)]
pub const FIXED_NATIVE_STARTUP_INFO_FLAGS: u32 = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;

#[cfg(windows)]
pub fn fixed_native_launch_spec(kind: ChildKind) -> FixedNativeLaunchSpec {
    let (application, mode, attribute_count) = match kind {
        ChildKind::Worker => (LAUNCHER_IMAGE, WORKER_MODE, 1),
        ChildKind::Observer => (OBSERVER_IMAGE, "observe-v1", 2),
    };
    FixedNativeLaunchSpec {
        application,
        mode,
        cwd: if kind == ChildKind::Observer { FIXED_OBSERVER_CWD } else { FIXED_CWD },
        creation_flags: if kind == ChildKind::Observer {
            (FIXED_NATIVE_CREATION_FLAGS & !CREATE_NO_WINDOW)
                | windows_sys::Win32::System::Threading::DETACHED_PROCESS
        } else { FIXED_NATIVE_CREATION_FLAGS },
        startup_info_flags: FIXED_NATIVE_STARTUP_INFO_FLAGS,
        inherited_handle_count: EXACT_INHERITED_HANDLE_COUNT,
        inherit_handles: true,
        attribute_count,
    }
}
pub const OBSERVER_LEAF_RIGHTS: [&str; 9] = [
    "FILE_READ_DATA",
    "FILE_READ_EA",
    "FILE_READ_ATTRIBUTES",
    "FILE_WRITE_DATA",
    "FILE_APPEND_DATA",
    "FILE_WRITE_EA",
    "FILE_WRITE_ATTRIBUTES",
    "READ_CONTROL",
    "SYNCHRONIZE",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ImageKind {
    Launcher,
    Observer,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChildKind {
    Worker,
    Observer,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessInformationDisposition {
    Valid,
    MalformedWithProcessHandle,
    MalformedWithoutProcessHandle,
}

pub fn classify_process_information(
    has_process_handle: bool,
    has_thread_handle: bool,
    handles_alias: bool,
    process_id: u32,
    thread_id: u32,
) -> ProcessInformationDisposition {
    if has_process_handle
        && has_thread_handle
        && !handles_alias
        && process_id != 0
        && thread_id != 0
    {
        ProcessInformationDisposition::Valid
    } else if has_process_handle {
        ProcessInformationDisposition::MalformedWithProcessHandle
    } else {
        ProcessInformationDisposition::MalformedWithoutProcessHandle
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StreamKind {
    Stdin,
    Stdout,
    Stderr,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Step {
    ValidateFixedBinding,
    FreezeImage(ImageKind),
    VerifyImage(ImageKind),
    FreezeSurface,
    VerifySurface,
    VerifySupervisorLedgerProof,
    CreateDurableLedger,
    FlushLedgerReadback,
    ReopenLedgerVerify,
    CreateOuterJob(JobLimits),
    VerifyOuterJob(JobLimits),
    VerifyAlreadyOuterContained,
    CreateInnerJob(JobLimits),
    VerifyInnerJob(JobLimits),
    GateSeIncreaseQuota,
    CreateRestrictedPrimaryToken {
        rights: u32,
        policy: RestrictedTokenPolicy,
    },
    SetLowIntegrity,
    DeriveRegularAppContainerSid,
    VerifyAppContainerZeroCapabilities,
    VerifyLoopbackNonExempt,
    CreateSuspendedChild(ChildKind),
    AssignOuterJob,
    AssignInnerJob,
    VerifyOuterMembership,
    VerifyObserverConfinement,
    ResumePrimaryThread,
    SampleThreadCount,
    BeginPinnedOverlappedPipes,
    StartConcurrentIo,
    Transfer(StreamKind),
    PollProcess,
    VerifySignaledProcess,
    RecheckDeadline,
    CancelOutstandingIo,
    RetireIoCompletion,
    TerminateProcessOnce,
    TerminateJobOnce,
    WaitForStableReap,
    FinalIdentityAclHashReverify,
    ReopenDurableEvidence,
    ReleaseHeldImageHandles,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum KernelReply {
    Ok,
    Refused(&'static str),
    Failed(&'static str),
    Unknown(&'static str),
    LedgerCollision,
    CreateFalseTrustworthy { kind: ChildKind, win32_error: u32 },
    CreateTrue { process_info_valid: bool },
    ResumeCount(u32),
    ThreadCount(u32),
    TransferComplete { bytes: usize },
    Eof { bytes: usize, canonical_frame: bool },
    EofBytes(Vec<u8>),
    BrokenPipe { bytes: usize, canonical_frame: bool },
    Cancelled,
    ExitCode(u32),
    StillActive,
    MatchingProcess,
    DeadlineNotReached,
    DeadlineReached,
    IoSubmitFailed { submitted: u8, pending_owned: u8 },
    CancelRaceRetained,
}

pub trait LauncherKernel {
    fn bind_context(&mut self, context: &ProductionInvocationContext) -> KernelReply;
    fn invoke(&mut self, step: Step) -> KernelReply;
    fn promoted_worker_outcome(&self) -> Option<(ReducerTerminal, String)> {
        None
    }
    fn worker_promotion_diagnostic(&self) -> WorkerPromotionDiagnostic {
        WorkerPromotionDiagnostic::default()
    }
    fn io_stop_observation(&self) -> (Option<IoNativeDiagnostic>, Option<u32>) {
        (None, None)
    }
    // Runs for every reducer disposition, before any cached evidence can escape.
    fn finalize_invocation(&mut self) -> Result<(), &'static str> { Ok(()) }
    fn snapshot_evidence(
        &mut self,
        context: &ProductionInvocationContext,
        child: ChildStartEvidence,
    ) -> Result<LauncherWireEvidenceV1, &'static str>;
}

pub const ALLOCATOR_CONTRACT: [&str; 4] = [
    "NetworkIsolation=every-entry-Sid-then-array:HeapFree(GetProcessHeap)",
    "derived-package-sid=FreeSid",
    "sid-strings-and-low-il=LocalFree",
    "known-folder=CoTaskMemFree",
];
pub const IMAGE_OPEN_CONTRACT: &str =
    "non-reparse|share-read-only-no-delete|READ_CONTROL|held-through-final-reverify";
pub const SURFACE_SECURITY_CONTRACT: &str = "trusted-owner|protected-non-null-dacl|closed-aces|fixed-low-il|no-delete-write-dac-write-owner-execute";
pub const PIPE_CONTRACT: &str = "overlapped-local|stored-before-submit|pinned-overlapped-events-and-buffers-through-terminal-retirement|exact-three-inherited|cap-plus-one|cancelioex-retired";
pub const NATIVE_RESIDUAL_BOUNDARY: &str = "Win32 calls are compiled but not executed by KAT; OS enforcement semantics require native acceptance";
pub const LEDGER_DURABILITY_CLAIM: &str =
    "write-through|flush|same-handle-readback|close-reopen-identity-acl-hash|not-power-loss-atomic";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScriptedOverride {
    pub ordinal: usize,
    pub reply: KernelReply,
}

#[derive(Clone, Default)]
pub struct SharedScriptedLedgerStore {
    inner: std::sync::Arc<std::sync::Mutex<ScriptedLedgerState>>,
}

#[derive(Default)]
struct ScriptedLedgerState {
    records: std::collections::BTreeMap<String, Vec<u8>>,
    create_order: Vec<String>,
}

impl SharedScriptedLedgerStore {
    pub fn create_order(&self) -> Vec<String> {
        self.inner
            .lock()
            .expect("scripted ledger lock")
            .create_order
            .clone()
    }

    pub fn seed_supervisor(&self, context: &ProductionInvocationContext) {
        let identity = context.supervisor_ledger_identity_sha256.clone();
        let record = context.ledger_record_bytes(LedgerStage::SupervisorBeforeWorker);
        let mut state = self.inner.lock().expect("scripted ledger lock");
        state.records.entry(identity).or_insert(record);
    }
}

pub struct ScriptedKernel {
    pub calls: Vec<Step>,
    pub bound_contexts: Vec<ProductionInvocationContext>,
    overrides: std::collections::VecDeque<ScriptedOverride>,
    matched_overrides: usize,
    pub containment_state: ContainmentState,
    pub pipe_states: [PipeState; 3],
    pub ledger_store: SharedScriptedLedgerStore,
    captured_stdout: Vec<u8>,
    stdout_eof: bool,
    stderr_eof: bool,
    stderr_nonzero_seen: bool,
    observed_exit_code: Option<i32>,
    promoted_evidence: Option<LauncherWireEvidenceV1>,
    promoted_worker_outcome: Option<(ReducerTerminal, String)>,
    promotion_diagnostic: WorkerPromotionDiagnostic,
}

impl Default for ScriptedKernel {
    fn default() -> Self {
        Self {
            calls: Vec::new(),
            bound_contexts: Vec::new(),
            overrides: std::collections::VecDeque::new(),
            matched_overrides: 0,
            containment_state: ContainmentState::Unstarted,
            pipe_states: [PipeState::Uninitialized; 3],
            ledger_store: SharedScriptedLedgerStore::default(),
            captured_stdout: Vec::new(),
            stdout_eof: false,
            stderr_eof: false,
            stderr_nonzero_seen: false,
            observed_exit_code: None,
            promoted_evidence: None,
            promoted_worker_outcome: None,
            promotion_diagnostic: WorkerPromotionDiagnostic::default(),
        }
    }
}

impl ScriptedKernel {
    pub fn with_overrides(overrides: Vec<ScriptedOverride>) -> Self {
        let mut previous = 0;
        for item in &overrides {
            assert!(
                item.ordinal > previous,
                "override ordinals must be unique and ordered"
            );
            previous = item.ordinal;
        }
        Self {
            calls: Vec::new(),
            bound_contexts: Vec::new(),
            overrides: overrides.into(),
            matched_overrides: 0,
            containment_state: ContainmentState::Unstarted,
            pipe_states: [PipeState::Uninitialized; 3],
            ledger_store: SharedScriptedLedgerStore::default(),
            captured_stdout: Vec::new(),
            stdout_eof: false,
            stderr_eof: false,
            stderr_nonzero_seen: false,
            observed_exit_code: None,
            promoted_evidence: None,
            promoted_worker_outcome: None,
            promotion_diagnostic: WorkerPromotionDiagnostic::default(),
        }
    }

    pub fn with_store(
        overrides: Vec<ScriptedOverride>,
        ledger_store: SharedScriptedLedgerStore,
    ) -> Self {
        let mut kernel = Self::with_overrides(overrides);
        kernel.ledger_store = ledger_store;
        kernel
    }

    pub fn matched_override_count(&self) -> usize {
        self.matched_overrides
    }

    fn record_transition(&mut self, step: Step, reply: &KernelReply) {
        match (step, reply) {
            (Step::BeginPinnedOverlappedPipes, KernelReply::Ok) => {
                self.pipe_states = [PipeState::Prepared; 3];
            }
            (Step::StartConcurrentIo, KernelReply::Ok) => {
                self.pipe_states = [PipeState::Pending; 3];
            }
            (
                Step::StartConcurrentIo,
                KernelReply::IoSubmitFailed {
                    submitted,
                    pending_owned,
                },
            ) => {
                self.pipe_states = [PipeState::Prepared; 3];
                for state in self.pipe_states.iter_mut().take(usize::from(*submitted)) {
                    *state = PipeState::Pending;
                }
                assert_eq!(*submitted, *pending_owned);
            }
            (
                Step::CreateSuspendedChild(_),
                KernelReply::CreateTrue {
                    process_info_valid: true,
                },
            ) => {
                self.containment_state = ContainmentState::SuspendedUnassigned;
            }
            (Step::AssignOuterJob, KernelReply::Ok) => {
                self.containment_state = ContainmentState::OuterAssignedPendingVerify;
            }
            (Step::AssignInnerJob, KernelReply::Ok) => {
                self.containment_state = ContainmentState::InnerAssignedPendingVerify;
            }
            (Step::VerifyOuterMembership, KernelReply::Ok)
                if self.containment_state == ContainmentState::OuterAssignedPendingVerify =>
            {
                self.containment_state = ContainmentState::OuterAssignedVerified;
            }
            (Step::VerifyObserverConfinement, KernelReply::Ok)
                if self.containment_state == ContainmentState::InnerAssignedPendingVerify =>
            {
                self.containment_state = ContainmentState::InnerAssignedVerified;
            }
            (Step::ResumePrimaryThread, KernelReply::ResumeCount(1)) => {
                self.containment_state = ContainmentState::ResumedExactlyOnce;
            }
            (Step::Transfer(StreamKind::Stdin), KernelReply::TransferComplete { bytes })
                if self
                    .bound_contexts
                    .last()
                    .is_some_and(|context| *bytes == context.canonical_request_bytes.len()) =>
            {
                self.pipe_states[0] = PipeState::Eof;
            }
            (
                Step::Transfer(StreamKind::Stdout),
                KernelReply::Eof { bytes, .. } | KernelReply::BrokenPipe { bytes, .. },
            ) => {
                self.pipe_states[1] = PipeState::Eof;
                self.stdout_eof = true;
                self.captured_stdout = vec![0; *bytes];
            }
            (Step::Transfer(StreamKind::Stdout), KernelReply::EofBytes(bytes)) => {
                self.pipe_states[1] = PipeState::Eof;
                self.stdout_eof = true;
                self.captured_stdout = bytes.clone();
            }
            (
                Step::Transfer(StreamKind::Stderr),
                KernelReply::Eof { bytes, .. } | KernelReply::BrokenPipe { bytes, .. },
            ) => {
                self.pipe_states[2] = PipeState::Eof;
                self.stderr_eof = true;
                self.stderr_nonzero_seen = *bytes != 0;
            }
            (Step::Transfer(StreamKind::Stderr), KernelReply::EofBytes(bytes)) => {
                self.pipe_states[2] = PipeState::Eof;
                self.stderr_eof = true;
                self.stderr_nonzero_seen = !bytes.is_empty();
            }
            (Step::PollProcess, KernelReply::ExitCode(code)) if *code <= i32::MAX as u32 => {
                self.observed_exit_code = Some(*code as i32);
            }
            (Step::CancelOutstandingIo, KernelReply::Ok | KernelReply::CancelRaceRetained) => {
                for state in &mut self.pipe_states {
                    if *state == PipeState::Pending {
                        *state = PipeState::CancelPending;
                    }
                }
            }
            (Step::RetireIoCompletion, KernelReply::Ok) => {
                self.pipe_states = [PipeState::Retired; 3];
            }
            (Step::Transfer(_), KernelReply::DeadlineReached) => {}
            (Step::Transfer(_), _) => {
                let index = match step {
                    Step::Transfer(StreamKind::Stdin) => 0,
                    Step::Transfer(StreamKind::Stdout) => 1,
                    Step::Transfer(StreamKind::Stderr) => 2,
                    _ => unreachable!(),
                };
                self.pipe_states[index] = PipeState::Failed;
            }
            _ => {}
        }
    }

    fn scripted_reply(&mut self, step: Step) -> KernelReply {
        let Some(context) = self.bound_contexts.last() else {
            return KernelReply::Refused("scripted production context absent");
        };
        match step {
            Step::VerifySupervisorLedgerProof => {
                let Some(proof) = context.supervisor_ledger_proof.as_ref() else {
                    return KernelReply::Refused("worker supervisor proof absent");
                };
                let state = self
                    .ledger_store
                    .inner
                    .lock()
                    .expect("scripted ledger lock");
                match state.records.get(&proof.supervisor_ledger_identity_sha256) {
                    Some(record)
                        if sha256_hex(record) == proof.supervisor_ledger_record_sha256
                            && *record
                                == context
                                    .ledger_record_bytes(LedgerStage::SupervisorBeforeWorker) =>
                    {
                        KernelReply::Ok
                    }
                    _ => KernelReply::Refused("supervisor ledger proof/store mismatch"),
                }
            }
            Step::CreateDurableLedger => {
                let mut state = self
                    .ledger_store
                    .inner
                    .lock()
                    .expect("scripted ledger lock");
                if state.records.contains_key(&context.ledger_identity_sha256) {
                    KernelReply::LedgerCollision
                } else {
                    state.records.insert(
                        context.ledger_identity_sha256.clone(),
                        context.ledger_record_bytes(match context.mode {
                            Mode::Supervisor => LedgerStage::SupervisorBeforeWorker,
                            Mode::Worker => LedgerStage::WorkerBeforeObserver,
                        }),
                    );
                    state
                        .create_order
                        .push(context.ledger_identity_sha256.clone());
                    KernelReply::Ok
                }
            }
            Step::CreateRestrictedPrimaryToken { rights, policy }
                if rights != TOKEN_RIGHTS || policy != RESTRICTED_TOKEN_POLICY =>
            {
                KernelReply::Refused("scripted restricted-token call policy drifted")
            }
            _ => default_scripted_reply(step, Some(context)),
        }
    }
}

fn successful_started_evidence(stdout: &[u8], exit_code: i32) -> LauncherWireEvidenceV1 {
    LauncherWireEvidenceV1 {
        kind: InvocationEvidenceKind::ChildStarted,
        invocation_attempt_count: 1,
        child_started: EvidenceChildStarted::Known(true),
        captured_stdout_base64: STANDARD.encode(stdout),
        captured_stderr_base64: String::new(),
        stdout_state: EvidenceStdoutState::Eof,
        stderr_state: EvidenceStderrState::EofZeroBytes,
        stream_closure_state: EvidenceStreamClosureState::BothEof,
        exit_state: EvidenceExitState::Known { code: exit_code },
    }
}

fn scripted_worker_result_bytes(supervisor: &ProductionInvocationContext) -> Vec<u8> {
    let worker = parse_production_input(
        Mode::Worker,
        &supervisor
            .supervisor_handoff_bytes()
            .expect("scripted supervisor handoff"),
    )
    .expect("scripted worker context");
    let reducer = ReducerResult {
        terminal: ReducerTerminal::Success,
        reason: "bounded fixed launcher invocation succeeded".into(),
        invocation_attempt_count: 1,
        child_start_evidence: ChildStartEvidence::Started,
        child_started: "true",
        ledger_state: "durable-consumed",
        sticky: false,
        handles_released: true,
    };
    serde_json::to_vec(&close_result_with_evidence(
        &worker,
        reducer,
        successful_started_evidence(&[], 0),
    ))
    .expect("scripted worker result serializes")
}

fn default_scripted_reply(
    step: Step,
    context: Option<&ProductionInvocationContext>,
) -> KernelReply {
    match step {
        Step::CreateSuspendedChild(_) => KernelReply::CreateTrue {
            process_info_valid: true,
        },
        Step::ResumePrimaryThread => KernelReply::ResumeCount(1),
        Step::SampleThreadCount => KernelReply::ThreadCount(1),
        Step::Transfer(StreamKind::Stdin) => KernelReply::TransferComplete {
            bytes: context
                .map(|value| value.canonical_request_bytes.len())
                .unwrap_or_default(),
        },
        Step::Transfer(StreamKind::Stdout) => match context {
            Some(context) if context.mode == Mode::Supervisor => {
                KernelReply::EofBytes(scripted_worker_result_bytes(context))
            }
            _ => KernelReply::EofBytes(Vec::new()),
        },
        Step::Transfer(StreamKind::Stderr) => KernelReply::Eof {
            bytes: 0,
            canonical_frame: true,
        },
        Step::PollProcess => KernelReply::ExitCode(0),
        Step::VerifySignaledProcess => KernelReply::MatchingProcess,
        Step::RecheckDeadline => KernelReply::DeadlineNotReached,
        _ => KernelReply::Ok,
    }
}

impl LauncherKernel for ScriptedKernel {
    fn bind_context(&mut self, context: &ProductionInvocationContext) -> KernelReply {
        self.bound_contexts.push(context.clone());
        KernelReply::Ok
    }

    fn invoke(&mut self, step: Step) -> KernelReply {
        self.calls.push(step);
        let ordinal = self.calls.len();
        let mut reply = if self
            .overrides
            .front()
            .is_some_and(|item| item.ordinal == ordinal)
        {
            self.matched_overrides += 1;
            self.overrides.pop_front().expect("front existed").reply
        } else {
            self.scripted_reply(step)
        };
        if step == Step::Transfer(StreamKind::Stdout) {
            if let KernelReply::EofBytes(bytes) = &reply {
                let context = self.bound_contexts.last().expect("bound context exists");
                if context.mode == Mode::Supervisor {
                    match promote_worker_result_observed(
                        context,
                        bytes,
                        &mut self.promotion_diagnostic,
                    ) {
                        Ok(parsed) => {
                            let evidence = parsed.evidence.clone();
                            self.promoted_worker_outcome = Some((parsed.terminal, parsed.reason));
                            self.promoted_evidence = Some(evidence);
                        }
                        Err(_) => {
                            reply = KernelReply::Failed("worker result wire promotion failed")
                        }
                    }
                } else if !validate_observer_stdout_framing(bytes) {
                    reply = KernelReply::Failed("observer stdout framing failed");
                }
            }
        }
        self.record_transition(step, &reply);
        reply
    }

    fn promoted_worker_outcome(&self) -> Option<(ReducerTerminal, String)> {
        self.promoted_worker_outcome.clone()
    }

    fn worker_promotion_diagnostic(&self) -> WorkerPromotionDiagnostic {
        self.promotion_diagnostic
    }

    fn snapshot_evidence(
        &mut self,
        context: &ProductionInvocationContext,
        child: ChildStartEvidence,
    ) -> Result<LauncherWireEvidenceV1, &'static str> {
        let evidence = if context.mode == Mode::Supervisor {
            match child {
                ChildStartEvidence::NeverStarted => conservative_wire_evidence(child),
                ChildStartEvidence::Started => self
                    .promoted_evidence
                    .clone()
                    .ok_or("supervisor has no validated worker evidence to promote")?,
                ChildStartEvidence::Ambiguous => conservative_wire_evidence(child),
            }
        } else if child != ChildStartEvidence::Started {
            conservative_wire_evidence(child)
        } else {
            let stdout_state = if self.captured_stdout.len() > MAX_STDOUT_BYTES {
                EvidenceStdoutState::CapExceededOrTruncated
            } else if self.stdout_eof {
                EvidenceStdoutState::Eof
            } else {
                EvidenceStdoutState::NotEofOrUnknown
            };
            let stderr_state = if self.stderr_nonzero_seen {
                EvidenceStderrState::NonzeroByteSeen
            } else if self.stderr_eof {
                EvidenceStderrState::EofZeroBytes
            } else {
                EvidenceStderrState::NotEofOrUnknown
            };
            let both_eof = stdout_state == EvidenceStdoutState::Eof
                && stderr_state == EvidenceStderrState::EofZeroBytes;
            LauncherWireEvidenceV1 {
                kind: InvocationEvidenceKind::ChildStarted,
                invocation_attempt_count: 1,
                child_started: EvidenceChildStarted::Known(true),
                captured_stdout_base64: STANDARD.encode(
                    &self.captured_stdout[..self.captured_stdout.len().min(MAX_STDOUT_BYTES)],
                ),
                captured_stderr_base64: String::new(),
                stdout_state,
                stderr_state,
                stream_closure_state: if both_eof {
                    EvidenceStreamClosureState::BothEof
                } else {
                    EvidenceStreamClosureState::IncompleteOrUnknown
                },
                exit_state: self
                    .observed_exit_code
                    .map(|code| EvidenceExitState::Known { code })
                    .unwrap_or(EvidenceExitState::Unknown),
            }
        };
        validate_wire_evidence(&evidence)?;
        Ok(evidence)
    }
}

#[cfg(windows)]
mod native_launcher_privilege;
#[cfg(windows)]
mod native_ledger_security;
#[cfg(windows)]
mod native_startup_files;
#[cfg(windows)]
type OwnedNativeHandle = native_startup_files::OwnedNativeHandle<TypedHandleKind>;
#[cfg(windows)]
use native_startup_files::{native_file_info, native_final_path, native_sha256};

#[cfg(windows)]
struct NativeDriveAnchorProvider;
#[cfg(windows)]
impl DriveAnchorProvider for NativeDriveAnchorProvider {
    type Handle = OwnedNativeHandle;
    fn drive_type(&mut self, path: &str) -> Result<u32, &'static str> {
        if path.len() != 3 || !path.as_bytes()[0].is_ascii_uppercase() || &path.as_bytes()[1..] != b":\\" {
            return Err("drive type path refused");
        }
        Ok(unsafe { windows_sys::Win32::Storage::FileSystem::GetDriveTypeW(wide(path).as_ptr()) })
    }
    fn open(&mut self, path: &str) -> Result<Self::Handle, &'static str> {
        // The only caller supplies the grammar-validated requested drive root.
        if path.len() != 7 || !path.starts_with(r"\\?\") || !path.as_bytes()[4].is_ascii_uppercase()
            || &path.as_bytes()[5..] != b":\\"
        { return Err("drive anchor open path refused"); }
        OwnedNativeHandle::new(unsafe {
            CreateFileW(wide(path).as_ptr(), FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, null(), OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, null_mut())
        }, TypedHandleKind::HeldAncestor).map_err(|_| "drive anchor open failed")
    }
    fn observe(&mut self, handle: &Self::Handle) -> Result<DriveAnchorObservation, &'static str> {
        let mut flags = 0;
        if unsafe { GetHandleInformation(handle.raw(), &mut flags) } == 0 || flags & HANDLE_FLAG_INHERIT != 0 {
            return Err("drive anchor inheritance refused");
        }
        let id: FILE_ID_INFO = native_file_info(handle.raw(), FileIdInfo)?;
        let basic: FILE_BASIC_INFO = native_file_info(handle.raw(), FileBasicInfo)?;
        let standard: FILE_STANDARD_INFO = native_file_info(handle.raw(), FileStandardInfo)?;
        Ok(DriveAnchorObservation {
            normalized_dos: native_drive_final_path(handle.raw(), 0)?,
            normalized_nt: native_drive_final_path(handle.raw(), 2)?,
            volume_serial: id.VolumeSerialNumber, file_id: id.FileId.Identifier,
            directory: standard.Directory, delete_pending: standard.DeletePending,
            reparse: basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0,
        })
    }
    fn close(&mut self, mut handle: Self::Handle) -> Result<(), &'static str> {
        let raw = std::mem::replace(&mut handle.raw, null_mut());
        if unsafe { CloseHandle(raw) } == 0 { Err("drive anchor close failed") } else { Ok(()) }
    }
}

#[cfg(windows)]
fn native_drive_final_path(handle: HANDLE, flags: u32) -> Result<String, &'static str> {
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
    let required = unsafe { GetFinalPathNameByHandleW(handle, null_mut(), 0, flags) };
    if required == 0 || required > 512 { return Err("drive anchor final path size refused"); }
    let mut units = vec![0u16; required as usize + 1];
    let written = unsafe { GetFinalPathNameByHandleW(handle, units.as_mut_ptr(), units.len() as u32, flags) };
    if written == 0 || written as usize >= units.len() || written > 512 {
        return Err("drive anchor final path readback refused");
    }
    String::from_utf16(&units[..written as usize]).map_err(|_| "drive anchor final path UTF16 refused")
}

#[cfg(all(windows, test))]
pub(crate) fn fixture_native_drive_anchor(context: &ProductionInvocationContext) -> String {
    let mut held = HeldDriveBinding::default();
    let mut provider = NativeDriveAnchorProvider;
    held.acquire(&mut provider, context).expect("native fixed-drive metadata acquisition");
    let record = held.generated(context).unwrap().canonical_record().to_owned();
    held.revalidate(&mut provider).expect("same-handle native drive recheck");
    held.finish(&mut provider).expect("native checked drive close");
    assert!(held.handle.is_none() && held.finalized && !held.failed);
    held.finish(&mut provider).expect("finalization is idempotent without a second close");
    assert!(provider.open(r"\\.\C:").is_err());
    assert!(provider.drive_type(r"\\server\share\").is_err());
    record
}

#[cfg(windows)]
#[derive(Clone, Debug, Eq, PartialEq)]
struct NativeSecuritySnapshot {
    owner_sid: String,
    dacl_ace_count: u32,
    low_integrity_no_write_up: bool,
    package_directory_ace: bool,
    package_leaf_ace: bool,
    ledger_descriptor_bytes: Option<Vec<u8>>,
}

#[cfg(windows)]
#[derive(Clone, Debug, Eq, PartialEq)]
struct NativeFileSnapshot {
    final_path: String,
    volume_serial: u64,
    file_id: [u8; 16],
    size: i64,
    link_count: u32,
    attributes: u32,
    creation_time: i64,
    last_access_time: i64,
    last_write_time: i64,
    change_time: i64,
    sha256: String,
    security: NativeSecuritySnapshot,
}

#[cfg(windows)]
impl NativeFileSnapshot {
    fn stable_integrity_matches(&self, other: &Self) -> bool {
        // Reading the held file may advance access time. Keep that observation,
        // but normalize only it in a copy; derived equality still covers every
        // present and future integrity/security field without a manual allowlist.
        let mut normalized = self.clone();
        normalized.last_access_time = other.last_access_time;
        normalized == *other
    }
}

#[cfg(windows)]
#[derive(Clone, Debug, Eq, PartialEq)]
struct NativeSurfaceSnapshot {
    final_path: String,
    attributes: u32,
    security: NativeSecuritySnapshot,
}

#[cfg(windows)]
#[derive(Debug)]
struct HeldNativeFile {
    handle: OwnedNativeHandle,
    snapshot: NativeFileSnapshot,
}

#[cfg(windows)]
#[derive(Debug)]
struct HeldNativeSurface {
    handle: OwnedNativeHandle,
    snapshot: NativeSurfaceSnapshot,
}

#[cfg(windows)]
#[derive(Debug)]
struct HeldObserverCwd {
    handle: OwnedNativeHandle,
    snapshot: (NativeSurfaceSnapshot, u64, [u8; 16]),
}

#[cfg(windows)]
fn observer_cwd_snapshot(handle: HANDLE, expected: &str)
    -> Result<(NativeSurfaceSnapshot, u64, [u8; 16]), &'static str>
{
    let final_path = native_final_path(handle)?;
    let basic: FILE_BASIC_INFO = native_file_info(handle, FileBasicInfo)?;
    let standard: FILE_STANDARD_INFO = native_file_info(handle, FileStandardInfo)?;
    let id: FILE_ID_INFO = native_file_info(handle, FileIdInfo)?;
    if final_path != expected || !final_path.starts_with(r"\\?\C:\")
        || basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || !standard.Directory || standard.DeletePending
    { return Err("observer CWD identity or type refused"); }
    Ok((NativeSurfaceSnapshot { final_path, attributes: basic.FileAttributes,
        security: query_observer_read_security(handle, ObserverReadRole::Cwd)? },
        id.VolumeSerialNumber, id.FileId.Identifier))
}

#[cfg(windows)]
#[derive(Debug)]
struct OwnedDerivedSid(PSID);

#[cfg(windows)]
impl Drop for OwnedDerivedSid {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                windows_sys::Win32::Security::FreeSid(self.0);
            }
            self.0 = null_mut();
        }
    }
}

#[cfg(windows)]
struct OwnedCoTaskMemWide(*mut u16);

#[cfg(windows)]
impl Drop for OwnedCoTaskMemWide {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CoTaskMemFree(self.0.cast()) };
            self.0 = null_mut();
        }
    }
}

#[cfg(windows)]
fn native_verify_program_data_binding() -> Result<(), &'static str> {
    let mut raw = null_mut();
    if unsafe { SHGetKnownFolderPath(&FOLDERID_ProgramData, 0, null_mut(), &mut raw) } < 0
        || raw.is_null()
    {
        return Err("SHGetKnownFolderPath(FOLDERID_ProgramData) failed");
    }
    let allocation = OwnedCoTaskMemWide(raw);
    let mut length = 0usize;
    while unsafe { *allocation.0.add(length) } != 0 {
        length += 1;
        if length > 32_767 {
            return Err("ProgramData known-folder path is oversized");
        }
    }
    let path = String::from_utf16(unsafe { std::slice::from_raw_parts(allocation.0, length) })
        .map_err(|_| "ProgramData known-folder path is not UTF-16")?;
    let fixed_prefix = format!(r"\\?\{}\", path.trim_end_matches('\\'));
    if !FIXED_CWD.starts_with(&fixed_prefix)
        || !LAUNCHER_LEDGER_ROOT.starts_with(&fixed_prefix)
        || !ACCEPTED_EVIDENCE_ROOT.starts_with(&fixed_prefix)
    {
        return Err("fixed storage roots are outside FOLDERID_ProgramData");
    }
    Ok(())
}

#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn sid_string(sid: PSID) -> Result<String, &'static str> {
    let mut text = null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 || text.is_null() {
        return Err("ConvertSidToStringSidW failed");
    }
    let mut length = 0usize;
    while unsafe { *text.add(length) } != 0 {
        length += 1;
    }
    let result = String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) })
        .map_err(|_| "SID string was not UTF-16");
    unsafe {
        LocalFree(text.cast());
    }
    result
}

#[cfg(windows)]
fn derive_fixed_package_sid() -> Result<OwnedDerivedSid, &'static str> {
    let name = wide(APPCONTAINER_PACKAGE_NAME);
    let mut sid = null_mut();
    let hr = unsafe { DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut sid) };
    if hr < 0 || sid.is_null() {
        return Err("DeriveAppContainerSidFromAppContainerName failed");
    }
    let sid = OwnedDerivedSid(sid);
    let sid_text = wide(&sid_string(sid.0)?);
    let mut folder = null_mut();
    if unsafe { GetAppContainerFolderPath(sid_text.as_ptr(), &mut folder) } < 0 || folder.is_null()
    {
        return Err("fixed regular AppContainer profile folder is unavailable");
    }
    let folder = OwnedCoTaskMemWide(folder);
    if unsafe { *folder.0 } == 0 {
        return Err("fixed regular AppContainer profile folder is empty");
    }
    Ok(sid)
}

#[cfg(windows)]
struct OwnedLocalAllocation(*mut c_void);

#[cfg(windows)]
impl Drop for OwnedLocalAllocation {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                LocalFree(self.0);
            }
            self.0 = null_mut();
        }
    }
}

#[cfg(windows)]
fn ace_mask_and_sid(ace: *mut c_void) -> Result<(u8, u8, u32, String), &'static str> {
    let header = unsafe { &*(ace.cast::<ACE_HEADER>()) };
    if header.AceSize < size_of::<ACCESS_ALLOWED_ACE>() as u16
        || !matches!(
            header.AceType as u32,
            ACCESS_ALLOWED_ACE_TYPE | ACCESS_DENIED_ACE_TYPE
        )
    {
        return Err("DACL contains an unclosed ACE type or size");
    }
    let allowed_layout = unsafe { &*(ace.cast::<ACCESS_ALLOWED_ACE>()) };
    let sid = (&allowed_layout.SidStart as *const u32)
        .cast_mut()
        .cast::<c_void>();
    Ok((
        header.AceType,
        header.AceFlags,
        allowed_layout.Mask,
        sid_string(sid)?,
    ))
}

#[cfg(windows)]
fn query_observer_read_security(handle: HANDLE, role: ObserverReadRole)
    -> Result<NativeSecuritySnapshot, &'static str>
{
    let standard: FILE_STANDARD_INFO = native_file_info(handle, FileStandardInfo)?;
    let mut token = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err("observer descriptor runtime user acquisition failed");
    }
    let token = OwnedNativeHandle::new(token, TypedHandleKind::Token)
        .map_err(|_| "observer descriptor runtime token invalid")?;
    let user = native_observer_token_bytes(token.raw(), TokenUser)?;
    let value: TOKEN_USER = observer_buffer_value(&user, 0)?;
    let user = observer_buffer_sid(&user, value.User.Sid)?;
    let package = derive_fixed_package_sid()?;
    let package = sid_string(package.0)?;
    let mut owner = null_mut(); let mut group = null_mut(); let mut dacl = null_mut();
    let mut descriptor = null_mut();
    let status = unsafe { GetSecurityInfo(handle, SE_FILE_OBJECT,
        OWNER_SECURITY_INFORMATION | windows_sys::Win32::Security::GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        &mut owner, &mut group, &mut dacl, null_mut(), &mut descriptor) };
    if status != ERROR_SUCCESS || descriptor.is_null() {
        return Err("observer read-only descriptor acquisition failed");
    }
    let _descriptor = OwnedLocalAllocation(descriptor);
    let security = native_observer_read_descriptor(descriptor)?;
    verify_observer_read_security(role, standard.Directory, &user, &package, &security)?;
    Ok(NativeSecuritySnapshot { owner_sid: security.owner, dacl_ace_count: 4,
        low_integrity_no_write_up: false, package_directory_ace: false,
        package_leaf_ace: false, ledger_descriptor_bytes: None })
}

#[cfg(windows)]
fn native_observer_read_descriptor(descriptor: *mut c_void) -> Result<ObserverReadSecurity, &'static str> {
    if descriptor.is_null() { return Err("observer descriptor absent"); }
    let mut owner = null_mut(); let mut group = null_mut(); let mut dacl = null_mut();
    let mut defaulted = 0; let mut present = 0;
    if unsafe { windows_sys::Win32::Security::GetSecurityDescriptorOwner(descriptor, &mut owner, &mut defaulted) } == 0
        || unsafe { windows_sys::Win32::Security::GetSecurityDescriptorGroup(descriptor, &mut group, &mut defaulted) } == 0
        || unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) } == 0
        || present == 0
    { return Err("observer descriptor components unavailable"); }
    if owner.is_null() || group.is_null() || dacl.is_null()
        || unsafe { windows_sys::Win32::Security::IsValidSecurityDescriptor(descriptor) } == 0
    { return Err("observer read-only descriptor incomplete"); }
    let mut control = 0; let mut revision = 0;
    if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0 {
        return Err("observer read-only descriptor control failed");
    }
    let mut info: ACL_SIZE_INFORMATION = unsafe { zeroed() };
    if unsafe { GetAclInformation(dacl, (&mut info as *mut ACL_SIZE_INFORMATION).cast(),
        size_of::<ACL_SIZE_INFORMATION>() as u32, AclSizeInformation) } == 0 || info.AceCount != 4 {
        return Err("observer read-only ACE count refused");
    }
    let mut aces = Vec::new();
    for index in 0..info.AceCount {
        let mut ace = null_mut();
        if unsafe { GetAce(dacl, index, &mut ace) } == 0 || ace.is_null() {
            return Err("observer read-only ACE acquisition failed");
        }
        aces.push(ace_mask_and_sid(ace)?);
    }
    Ok(ObserverReadSecurity { protected: control & SE_DACL_PROTECTED != 0,
        dacl_present: control & 4 != 0, owner: sid_string(owner)?, group: sid_string(group)?, aces })
}

#[cfg(windows)]
fn query_native_security(
    handle: HANDLE,
    require_low_integrity: bool,
    require_package_aces: bool,
) -> Result<NativeSecuritySnapshot, &'static str> {
    let mut owner: PSID = null_mut();
    let mut dacl: *mut ACL = null_mut();
    let mut sacl: *mut ACL = null_mut();
    let mut descriptor = null_mut();
    let mut information = OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
    if require_low_integrity {
        information |= LABEL_SECURITY_INFORMATION;
    }
    let status = unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            information,
            &mut owner,
            null_mut(),
            &mut dacl,
            &mut sacl,
            &mut descriptor,
        )
    };
    if status != ERROR_SUCCESS || descriptor.is_null() || owner.is_null() || dacl.is_null() {
        return Err("GetSecurityInfo returned incomplete owner/DACL evidence");
    }
    let _descriptor = OwnedLocalAllocation(descriptor);
    let owner_sid = sid_string(owner)?;
    if owner_sid != "S-1-5-18" && owner_sid != "S-1-5-32-544" {
        return Err("file owner is not LocalSystem or Builtin Administrators");
    }
    let mut control = 0u16;
    let mut revision = 0u32;
    if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0
        || control & SE_DACL_PROTECTED == 0
    {
        return Err("DACL is not protected");
    }
    let mut acl_info: ACL_SIZE_INFORMATION = unsafe { zeroed() };
    if unsafe {
        GetAclInformation(
            dacl,
            (&mut acl_info as *mut ACL_SIZE_INFORMATION).cast(),
            size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    } == 0
        || acl_info.AceCount == 0
    {
        return Err("DACL size evidence is unavailable or empty");
    }
    let package_sid = derive_fixed_package_sid()?;
    let package_sid_text = sid_string(package_sid.0)?;
    let package_directory_mask = 0x0002 | 0x0020 | 0x0080 | 0x0002_0000 | 0x0010_0000;
    let package_leaf_mask =
        0x0001 | 0x0008 | 0x0080 | 0x0002 | 0x0004 | 0x0010 | 0x0100 | 0x0002_0000 | 0x0010_0000;
    let ambient_rx_mask = 0x0001 | 0x0008 | 0x0080 | 0x0020 | 0x0002_0000 | 0x0010_0000;
    let mut package_directory_ace = false;
    let mut package_leaf_ace = false;
    for index in 0..acl_info.AceCount {
        let mut ace = null_mut();
        if unsafe { GetAce(dacl, index, &mut ace) } == 0 || ace.is_null() {
            return Err("GetAce failed");
        }
        let (ace_type, flags, mask, sid) = ace_mask_and_sid(ace)?;
        if ace_type as u32 == ACCESS_ALLOWED_ACE_TYPE && sid == package_sid_text {
            let directory = mask == package_directory_mask && flags == 0;
            let leaf = mask == package_leaf_mask && flags == 0x09;
            if !directory && !leaf {
                return Err("fixed package ACE mask or inheritance flags are inexact");
            }
            package_directory_ace |= directory;
            package_leaf_ace |= leaf;
        } else if ace_type as u32 == ACCESS_ALLOWED_ACE_TYPE
            && matches!(sid.as_str(), "S-1-1-0" | "S-1-5-32-545" | "S-1-15-2-1")
            && mask & !ambient_rx_mask != 0
        {
            return Err("ambient or ALL APPLICATION PACKAGES ACE exceeds RX/read/traverse");
        } else if ace_type as u32 == ACCESS_ALLOWED_ACE_TYPE
            && !matches!(
                sid.as_str(),
                "S-1-5-18" | "S-1-5-32-544" | "S-1-1-0" | "S-1-5-32-545" | "S-1-15-2-1"
            )
        {
            return Err("DACL grants an unrecognized principal");
        }
        if mask & (0x0001_0000 | 0x0040 | 0x0004_0000 | 0x0008_0000) != 0 && sid == package_sid_text
        {
            return Err("package ACE grants delete, delete-child, WRITE_DAC, or WRITE_OWNER");
        }
    }
    if require_package_aces && (!package_directory_ace || !package_leaf_ace) {
        return Err("fixed package directory/leaf ACE pair is absent or inexact");
    }

    let mut low_integrity_no_write_up = false;
    if require_low_integrity {
        if sacl.is_null() {
            return Err("mandatory label SACL is null");
        }
        let mut sacl_info: ACL_SIZE_INFORMATION = unsafe { zeroed() };
        if unsafe {
            GetAclInformation(
                sacl,
                (&mut sacl_info as *mut ACL_SIZE_INFORMATION).cast(),
                size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        } == 0
        {
            return Err("mandatory label ACL size evidence failed");
        }
        for index in 0..sacl_info.AceCount {
            let mut ace = null_mut();
            if unsafe { GetAce(sacl, index, &mut ace) } == 0 || ace.is_null() {
                return Err("mandatory label GetAce failed");
            }
            let header = unsafe { &*(ace.cast::<ACE_HEADER>()) };
            if header.AceType as u32 == SYSTEM_MANDATORY_LABEL_ACE_TYPE {
                let label = unsafe { &*(ace.cast::<SYSTEM_MANDATORY_LABEL_ACE>()) };
                let sid = (&label.SidStart as *const u32).cast_mut().cast::<c_void>();
                low_integrity_no_write_up = sid_string(sid)? == "S-1-16-4096"
                    && label.Mask & SYSTEM_MANDATORY_LABEL_NO_WRITE_UP != 0;
            }
        }
        if !low_integrity_no_write_up {
            return Err("fixed low-integrity mandatory label is absent");
        }
    }

    Ok(NativeSecuritySnapshot {
        owner_sid,
        dacl_ace_count: acl_info.AceCount,
        low_integrity_no_write_up,
        package_directory_ace,
        package_leaf_ace,
        ledger_descriptor_bytes: None,
    })
}

#[cfg(windows)]
fn native_file_snapshot(
    handle: HANDLE,
    expected_final_path: &str,
    require_low_integrity: bool,
    require_package_aces: bool,
    kind: TypedHandleKind,
) -> Result<NativeFileSnapshot, &'static str> {
    let final_path = native_final_path(handle)?;
    if final_path != expected_final_path || !final_path.starts_with(r"\\?\C:\") {
        return Err("opened file final path is not the exact normalized DOS binding");
    }
    let id: FILE_ID_INFO = native_file_info(handle, FileIdInfo)?;
    let standard: FILE_STANDARD_INFO = native_file_info(handle, FileStandardInfo)?;
    let basic: FILE_BASIC_INFO = native_file_info(handle, FileBasicInfo)?;
    if standard.Directory
        || standard.DeletePending
        || standard.NumberOfLinks != 1
        || basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err("file is directory, delete-pending, reparse, or not single-link");
    }
    Ok(NativeFileSnapshot {
        final_path,
        volume_serial: id.VolumeSerialNumber,
        file_id: id.FileId.Identifier,
        size: standard.EndOfFile,
        link_count: standard.NumberOfLinks,
        attributes: basic.FileAttributes,
        creation_time: basic.CreationTime,
        last_access_time: basic.LastAccessTime,
        last_write_time: basic.LastWriteTime,
        change_time: basic.ChangeTime,
        sha256: native_sha256(handle)?,
        security: if kind == TypedHandleKind::Ledger {
            let security = native_ledger_security::query_ledger_security(handle)?;
            NativeSecuritySnapshot {
                owner_sid: security.owner_sid,
                dacl_ace_count: security.dacl_ace_count,
                low_integrity_no_write_up: security.low_integrity_no_write_up,
                package_directory_ace: false,
                package_leaf_ace: false,
                ledger_descriptor_bytes: Some(security.descriptor_bytes),
            }
        } else if expected_final_path == OBSERVER_IMAGE && kind == TypedHandleKind::HeldImage {
            query_observer_read_security(handle, ObserverReadRole::Image)?
        } else {
            query_native_security(handle, require_low_integrity, require_package_aces)?
        },
    })
}

#[cfg(windows)]
fn open_native_file(
    path: &str,
    require_low_integrity: bool,
    require_package_aces: bool,
    kind: TypedHandleKind,
) -> Result<HeldNativeFile, &'static str> {
    let path_wide = wide(path);
    let handle = OwnedNativeHandle::new(
        unsafe {
            CreateFileW(
                path_wide.as_ptr(),
                FILE_READ_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL,
                FILE_SHARE_READ,
                null(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        },
        kind,
    )
    .map_err(|_| "CreateFileW fixed image open failed")?;
    let snapshot = native_file_snapshot(
        handle.raw(),
        path,
        require_low_integrity,
        require_package_aces,
        kind,
    )?;
    Ok(HeldNativeFile { handle, snapshot })
}

#[cfg(windows)]
fn open_native_surface(
    path: &str,
    require_package_aces: bool,
) -> Result<HeldNativeSurface, &'static str> {
    let path_wide = wide(path);
    let handle = OwnedNativeHandle::new(
        unsafe {
            CreateFileW(
                path_wide.as_ptr(),
                FILE_READ_ATTRIBUTES | READ_CONTROL,
                FILE_SHARE_READ,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        },
        TypedHandleKind::HeldAncestor,
    )
    .map_err(|_| "CreateFileW fixed surface open failed")?;
    let snapshot = native_surface_snapshot(handle.raw(), path, require_package_aces)?;
    Ok(HeldNativeSurface { handle, snapshot })
}

#[cfg(windows)]
fn native_surface_snapshot(
    handle: HANDLE,
    expected_path: &str,
    require_package_aces: bool,
) -> Result<NativeSurfaceSnapshot, &'static str> {
    let final_path = native_final_path(handle)?;
    let basic: FILE_BASIC_INFO = native_file_info(handle, FileBasicInfo)?;
    if final_path != expected_path
        || !final_path.starts_with(r"\\?\C:\")
        || basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err("surface final path or reparse state drifted");
    }
    let snapshot = NativeSurfaceSnapshot {
        final_path,
        attributes: basic.FileAttributes,
        security: query_native_security(handle, true, require_package_aces)?,
    };
    Ok(snapshot)
}

#[cfg(windows)]
#[derive(Debug)]
struct NativeLedger {
    path: String,
    record_bytes: Vec<u8>,
    handle: Option<OwnedNativeHandle>,
    frozen: Option<NativeFileSnapshot>,
}

#[cfg(windows)]
fn native_read_exact(handle: HANDLE, expected: &[u8]) -> Result<(), &'static str> {
    if unsafe { SetFilePointerEx(handle, 0, null_mut(), FILE_BEGIN) } == 0 {
        return Err("SetFilePointerEx before ledger readback failed");
    }
    let mut actual = vec![0u8; expected.len()];
    let mut offset = 0usize;
    while offset < actual.len() {
        let mut read = 0u32;
        if unsafe {
            ReadFile(
                handle,
                actual[offset..].as_mut_ptr(),
                (actual.len() - offset) as u32,
                &mut read,
                null_mut(),
            )
        } == 0
            || read == 0
        {
            return Err("ledger readback failed or ended early");
        }
        offset += read as usize;
    }
    let mut sentinel = 0u8;
    let mut sentinel_read = 0u32;
    if unsafe { ReadFile(handle, &mut sentinel, 1, &mut sentinel_read, null_mut()) } == 0
        || sentinel_read != 0
        || actual != expected
    {
        return Err("ledger readback was not exact canonical bytes plus EOF");
    }
    Ok(())
}

#[cfg(windows)]
fn native_create_ledger(
    context: &ProductionInvocationContext,
) -> Result<NativeLedger, KernelReply> {
    let record_bytes = context.ledger_record_bytes(match context.mode {
        Mode::Supervisor => LedgerStage::SupervisorBeforeWorker,
        Mode::Worker => LedgerStage::WorkerBeforeObserver,
    });
    let path = format!(
        "{}\\{}.json",
        LAUNCHER_LEDGER_ROOT, context.ledger_identity_sha256
    );
    use native_ledger_security::LedgerCreateError;
    use std::os::windows::io::IntoRawHandle;
    let file = native_ledger_security::create_new_ledger(&path, &record_bytes).map_err(
        |error| match error {
            LedgerCreateError::Collision => KernelReply::LedgerCollision,
            LedgerCreateError::BeforeCreate(reason) => KernelReply::Refused(reason),
            LedgerCreateError::AfterCreate(reason) => KernelReply::Unknown(reason),
            LedgerCreateError::PrivilegeRestoration(reason) => KernelReply::Unknown(reason),
            LedgerCreateError::CreateFailed(_) => {
                KernelReply::Unknown("CREATE_NEW ledger outcome failed")
            }
        },
    )?;
    let handle = OwnedNativeHandle::new(file.into_raw_handle(), TypedHandleKind::Ledger)
        .map_err(|_| KernelReply::Unknown("created ledger handle transfer failed"))?;
    Ok(NativeLedger {
        path,
        record_bytes,
        handle: Some(handle),
        frozen: None,
    })
}

#[cfg(windows)]
#[derive(Debug)]
struct NativeJob {
    handle: OwnedNativeHandle,
    limits: JobLimits,
}

#[cfg(windows)]
fn native_create_job(limits: JobLimits, kind: TypedHandleKind) -> Result<NativeJob, &'static str> {
    let handle = OwnedNativeHandle::new(unsafe { CreateJobObjectW(null(), null()) }, kind)
        .map_err(|_| "CreateJobObjectW failed")?;
    let mut flags = 0u32;
    if unsafe { GetHandleInformation(handle.raw(), &mut flags) } == 0 || flags & 1 != 0 {
        return Err("job handle is inheritable or unverifiable");
    }
    let mut extended: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    extended.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
        | JOB_OBJECT_LIMIT_PROCESS_MEMORY
        | JOB_OBJECT_LIMIT_JOB_MEMORY;
    extended.BasicLimitInformation.ActiveProcessLimit = limits.active_process_limit;
    extended.ProcessMemoryLimit = limits.process_memory_bytes as usize;
    extended.JobMemoryLimit = limits.job_memory_bytes as usize;
    if unsafe {
        SetInformationJobObject(
            handle.raw(),
            JobObjectExtendedLimitInformation,
            (&extended as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    } == 0
    {
        return Err("SetInformationJobObject extended limits failed");
    }
    let mut cpu: JOBOBJECT_CPU_RATE_CONTROL_INFORMATION = unsafe { zeroed() };
    cpu.ControlFlags = JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP;
    cpu.Anonymous.CpuRate = limits.cpu_rate_percent * 100;
    if unsafe {
        SetInformationJobObject(
            handle.raw(),
            JobObjectCpuRateControlInformation,
            (&cpu as *const JOBOBJECT_CPU_RATE_CONTROL_INFORMATION).cast(),
            size_of::<JOBOBJECT_CPU_RATE_CONTROL_INFORMATION>() as u32,
        )
    } == 0
    {
        return Err("SetInformationJobObject CPU hard cap failed");
    }
    let job = NativeJob { handle, limits };
    native_verify_job(&job)?;
    Ok(job)
}

#[cfg(windows)]
fn native_verify_job(job: &NativeJob) -> Result<(), &'static str> {
    let mut extended: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    if unsafe {
        QueryInformationJobObject(
            job.handle.raw(),
            JobObjectExtendedLimitInformation,
            (&mut extended as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            null_mut(),
        )
    } == 0
    {
        return Err("QueryInformationJobObject extended limits failed");
    }
    let expected_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
        | JOB_OBJECT_LIMIT_PROCESS_MEMORY
        | JOB_OBJECT_LIMIT_JOB_MEMORY;
    if extended.BasicLimitInformation.LimitFlags != expected_flags
        || extended.BasicLimitInformation.LimitFlags
            & (JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK)
            != 0
        || extended.BasicLimitInformation.ActiveProcessLimit != job.limits.active_process_limit
        || extended.ProcessMemoryLimit != job.limits.process_memory_bytes as usize
        || extended.JobMemoryLimit != job.limits.job_memory_bytes as usize
    {
        return Err("job extended-limit readback drifted");
    }
    let mut cpu: JOBOBJECT_CPU_RATE_CONTROL_INFORMATION = unsafe { zeroed() };
    if unsafe {
        QueryInformationJobObject(
            job.handle.raw(),
            JobObjectCpuRateControlInformation,
            (&mut cpu as *mut JOBOBJECT_CPU_RATE_CONTROL_INFORMATION).cast(),
            size_of::<JOBOBJECT_CPU_RATE_CONTROL_INFORMATION>() as u32,
            null_mut(),
        )
    } == 0
        || cpu.ControlFlags
            != JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP
        || unsafe { cpu.Anonymous.CpuRate } != job.limits.cpu_rate_percent * 100
    {
        return Err("job CPU hard-cap readback drifted");
    }
    Ok(())
}

#[cfg(windows)]
fn native_open_process_token(process: HANDLE) -> Result<OwnedNativeHandle, &'static str> {
    let mut token = null_mut();
    if unsafe {
        OpenProcessToken(
            process,
            TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT,
            &mut token,
        )
    } == 0
    {
        return Err("OpenProcessToken exact rights failed");
    }
    OwnedNativeHandle::new(token, TypedHandleKind::Token)
        .map_err(|_| "OpenProcessToken returned invalid handle")
}

#[cfg(windows)]
fn native_token_information(handle: HANDLE, class: i32) -> Result<Vec<u8>, &'static str> {
    let mut required = 0u32;
    unsafe {
        GetTokenInformation(handle, class, null_mut(), 0, &mut required);
    }
    if required == 0 || required > 1024 * 1024 {
        return Err("GetTokenInformation length was unavailable or excessive");
    }
    let mut buffer = vec![0u8; required as usize];
    if unsafe {
        GetTokenInformation(
            handle,
            class,
            buffer.as_mut_ptr().cast(),
            required,
            &mut required,
        )
    } == 0
    {
        return Err("GetTokenInformation data failed");
    }
    buffer.truncate(required as usize);
    Ok(buffer)
}

#[cfg(windows)]
fn native_gate_increase_quota(source: HANDLE) -> Result<(), &'static str> {
    let name = wide("SeIncreaseQuotaPrivilege");
    let mut luid: LUID = unsafe { zeroed() };
    if unsafe { LookupPrivilegeValueW(null(), name.as_ptr(), &mut luid) } == 0 {
        return Err("LookupPrivilegeValueW SeIncreaseQuota failed");
    }
    let mut impersonation = null_mut();
    if unsafe {
        DuplicateTokenEx(
            source,
            TOKEN_QUERY,
            null(),
            SecurityImpersonation,
            TokenImpersonation,
            &mut impersonation,
        )
    } == 0
    {
        return Err("DuplicateTokenEx quota-check token failed");
    }
    let impersonation = OwnedNativeHandle::new(impersonation, TypedHandleKind::Token)
        .map_err(|_| "quota-check token handle invalid")?;
    let mut required = PRIVILEGE_SET {
        PrivilegeCount: 1,
        Control: 1,
        Privilege: [LUID_AND_ATTRIBUTES {
            Luid: luid,
            Attributes: SE_PRIVILEGE_ENABLED,
        }],
    };
    let mut enabled = 0;
    if unsafe { PrivilegeCheck(impersonation.raw(), &mut required, &mut enabled) } == 0
        || enabled == 0
    {
        return Err("SeIncreaseQuota is not enabled");
    }
    Ok(())
}

#[cfg(windows)]
fn native_observer_token_bytes(token: HANDLE, class: i32) -> Result<Vec<u8>, &'static str> {
    let mut required = 0;
    let ok = unsafe { GetTokenInformation(token, class, null_mut(), 0, &mut required) };
    let code = unsafe { GetLastError() };
    if ok != 0 || code != windows_sys::Win32::Foundation::ERROR_INSUFFICIENT_BUFFER
        || !(4..=1024 * 1024).contains(&required)
    { return Err("observer token sizing refused"); }
    let mut bytes = vec![0; required as usize];
    let capacity = required;
    if unsafe { GetTokenInformation(token, class, bytes.as_mut_ptr().cast(), capacity, &mut required) } == 0
        || required < 4 || required > capacity
    { return Err("observer token acquisition refused"); }
    bytes.truncate(required as usize);
    Ok(bytes)
}
#[cfg(windows)]
fn observer_buffer_value<T: Copy>(bytes: &[u8], offset: usize) -> Result<T, &'static str> {
    if offset.checked_add(size_of::<T>()).is_none_or(|end| end > bytes.len()) {
        return Err("observer token buffer truncated");
    }
    Ok(unsafe { bytes.as_ptr().add(offset).cast::<T>().read_unaligned() })
}
#[cfg(windows)]
fn observer_buffer_sid(bytes: &[u8], sid: PSID) -> Result<String, &'static str> {
    let offset = (sid as usize).checked_sub(bytes.as_ptr() as usize)
        .ok_or("observer SID outside token buffer")?;
    let header = bytes.get(offset..).and_then(|rest| rest.get(..8))
        .ok_or("observer SID header truncated")?;
    let length = 8 + 4 * header[1] as usize;
    if offset.checked_add(length).is_none_or(|end| end > bytes.len())
        || unsafe { IsValidSid(sid) } == 0
    { return Err("observer SID body invalid"); }
    sid_string(sid)
}
#[cfg(windows)]
fn native_observer_notify_luid() -> Result<(u32, i32), &'static str> {
    let mut luid: LUID = unsafe { zeroed() };
    if unsafe { LookupPrivilegeValueW(null(), wide("SeChangeNotifyPrivilege").as_ptr(), &mut luid) } == 0 {
        return Err("observer traversal privilege lookup failed");
    }
    Ok((luid.LowPart, luid.HighPart))
}
#[cfg(windows)]
fn native_observer_token_snapshot(token: HANDLE) -> Result<ObserverTokenSnapshot, &'static str> {
    let user = native_observer_token_bytes(token, TokenUser)?;
    let user_value: TOKEN_USER = observer_buffer_value(&user, 0)?;
    let user = observer_buffer_sid(&user, user_value.User.Sid)?;
    let groups = native_observer_token_bytes(token, TokenGroups)?;
    let count: u32 = observer_buffer_value(&groups, 0)?;
    if count > 4096 { return Err("observer group count excessive"); }
    let mut group_values = Vec::new();
    for index in 0..count as usize {
        let group: SID_AND_ATTRIBUTES = observer_buffer_value(&groups,
            std::mem::offset_of!(TOKEN_GROUPS, Groups) + index * size_of::<SID_AND_ATTRIBUTES>())?;
        group_values.push((observer_buffer_sid(&groups, group.Sid)?, group.Attributes));
    }
    let rights = native_observer_token_bytes(token, TokenPrivileges)?;
    let count: u32 = observer_buffer_value(&rights, 0)?;
    if count > 4096 { return Err("observer privilege count excessive"); }
    let mut privileges = Vec::new();
    for index in 0..count as usize {
        let p: LUID_AND_ATTRIBUTES = observer_buffer_value(&rights,
            std::mem::offset_of!(TOKEN_PRIVILEGES, Privileges) + index * size_of::<LUID_AND_ATTRIBUTES>())?;
        privileges.push(((p.Luid.LowPart, p.Luid.HighPart), p.Attributes));
    }
    let integrity = native_observer_token_bytes(token, TokenIntegrityLevel)?;
    let label: TOKEN_MANDATORY_LABEL = observer_buffer_value(&integrity, 0)?;
    Ok(ObserverTokenSnapshot { user, groups: group_values, privileges,
        integrity: observer_buffer_sid(&integrity, label.Label.Sid)?,
        integrity_attributes: label.Label.Attributes,
        token_type: observer_buffer_value(&native_observer_token_bytes(token, TokenType)?, 0)? })
}

#[cfg(windows)]
fn native_create_restricted_primary(source: HANDLE) -> Result<OwnedNativeHandle, &'static str> {
    let baseline = native_observer_token_snapshot(source)?;
    let notify = native_observer_notify_luid()?;
    let expected = observer_expected_token(&baseline, notify, false)?;
    let mut disabled_allocations = Vec::new();
    let mut disabled_groups = Vec::new();
    for (sid, flags) in &baseline.groups {
        if *flags != 16 && expected.groups.iter().any(|(name, flags)| name == sid && *flags == 16) {
            let mut raw = null_mut();
            if unsafe { ConvertStringSidToSidW(wide(sid).as_ptr(), &mut raw) } == 0 || raw.is_null() {
                return Err("observer disabled group SID acquisition failed");
            }
            disabled_allocations.push(OwnedLocalAllocation(raw));
            disabled_groups.push(SID_AND_ATTRIBUTES { Sid: raw, Attributes: 0 });
        }
    }

    let privileges_buffer = native_token_information(source, TokenPrivileges)?;
    let privilege_offset = std::mem::offset_of!(TOKEN_PRIVILEGES, Privileges);
    if privileges_buffer.len() < privilege_offset {
        return Err("source privilege enumeration header is truncated");
    }
    let privilege_count = u32::from_ne_bytes(
        privileges_buffer[..size_of::<u32>()]
            .try_into()
            .map_err(|_| "source privilege count is truncated")?,
    ) as usize;
    let privilege_bytes = privilege_count
        .checked_mul(size_of::<LUID_AND_ATTRIBUTES>())
        .and_then(|bytes| privilege_offset.checked_add(bytes))
        .ok_or("source privilege enumeration size overflow")?;
    if privilege_bytes > privileges_buffer.len() {
        return Err("source privilege enumeration is truncated");
    }
    let enumerated_privileges: Vec<LUID_AND_ATTRIBUTES> = (0..privilege_count)
        .map(|index| unsafe {
            privileges_buffer
                .as_ptr()
                .add(privilege_offset + index * size_of::<LUID_AND_ATTRIBUTES>())
                .cast::<LUID_AND_ATTRIBUTES>()
                .read_unaligned()
        })
        .collect();
    if enumerated_privileges
        .iter()
        .enumerate()
        .any(|(index, left)| {
            enumerated_privileges[index + 1..].iter().any(|right| {
                left.Luid.LowPart == right.Luid.LowPart && left.Luid.HighPart == right.Luid.HighPart
            })
        })
    {
        return Err("source privilege enumeration contains duplicate LUIDs");
    }
    let delete_privileges: Vec<_> = enumerated_privileges.into_iter()
        .filter(|p| (p.Luid.LowPart, p.Luid.HighPart) != notify).collect();
    if delete_privileges.len() + 1 != privilege_count {
        return Err("source privilege deletion list coverage differs");
    }
    let delete_privileges_pointer = if delete_privileges.is_empty() {
        null()
    } else {
        delete_privileges.as_ptr()
    };
    let mut restricted = null_mut();
    if unsafe {
        CreateRestrictedToken(
            source,
            RESTRICTED_TOKEN_POLICY.flags,
            disabled_groups.len() as u32,
            disabled_groups.as_ptr(),
            delete_privileges.len() as u32,
            delete_privileges_pointer,
            0,
            null(),
            &mut restricted,
        )
    } == 0
    {
        return Err("CreateRestrictedToken closed group/privilege policy failed");
    }
    let restricted = OwnedNativeHandle::new(restricted, TypedHandleKind::Token)
        .map_err(|_| "restricted token handle invalid")?;
    verify_observer_token_transform(&baseline, notify, false,
        || native_observer_token_snapshot(restricted.raw()))?;
    let mut primary = null_mut();
    if unsafe {
        DuplicateTokenEx(
            restricted.raw(),
            TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT,
            null(),
            SecurityImpersonation,
            TokenPrimary,
            &mut primary,
        )
    } == 0
    {
        return Err("DuplicateTokenEx exact-rights primary token failed");
    }
    let primary = OwnedNativeHandle::new(primary, TypedHandleKind::Token)
        .map_err(|_| "primary token handle invalid")?;
    verify_observer_token_transform(&baseline, notify, false,
        || native_observer_token_snapshot(primary.raw()))?;
    Ok(primary)
}

#[cfg(windows)]
fn native_set_low_integrity(token: HANDLE) -> Result<(), &'static str> {
    let low = wide("S-1-16-4096");
    let mut sid = null_mut();
    if unsafe { ConvertStringSidToSidW(low.as_ptr(), &mut sid) } == 0 || sid.is_null() {
        return Err("ConvertStringSidToSidW low IL failed");
    }
    let _sid = OwnedLocalAllocation(sid);
    let label = TOKEN_MANDATORY_LABEL {
        Label: SID_AND_ATTRIBUTES {
            Sid: sid,
            Attributes: SE_GROUP_INTEGRITY as u32,
        },
    };
    let size = size_of::<TOKEN_MANDATORY_LABEL>() as u32 + unsafe { GetLengthSid(sid) };
    if unsafe {
        SetTokenInformation(
            token,
            TokenIntegrityLevel,
            (&label as *const TOKEN_MANDATORY_LABEL).cast(),
            size,
        )
    } == 0
    {
        return Err("SetTokenInformation low IL failed");
    }
    Ok(())
}

#[cfg(windows)]
fn native_verify_restricted_primary(source: HANDLE, token: HANDLE) -> Result<(), &'static str> {
    verify_observer_token_transform(&native_observer_token_snapshot(source)?,
        native_observer_notify_luid()?, true, || native_observer_token_snapshot(token))
}

#[cfg(windows)]
pub fn release_network_isolation_allocations(
    entry_sids: &[*mut c_void],
    entries_array: *mut c_void,
    mut heap_free: impl FnMut(*mut c_void) -> bool,
) -> bool {
    let mut all_released = true;
    for &sid in entry_sids {
        if sid.is_null() {
            all_released = false;
        } else if !heap_free(sid) {
            all_released = false;
        }
    }
    if entries_array.is_null() || !heap_free(entries_array) {
        all_released = false;
    }
    all_released
}

#[cfg(windows)]
fn native_verify_loopback_nonexempt(package_sid: PSID) -> Result<(), &'static str> {
    let mut count = 0u32;
    let mut entries: *mut SID_AND_ATTRIBUTES = null_mut();
    let status = unsafe { NetworkIsolationGetAppContainerConfig(&mut count, &mut entries) };
    if status != ERROR_SUCCESS {
        return Err("NetworkIsolationGetAppContainerConfig failed");
    }
    if count > 0 && entries.is_null() {
        return Err("NetworkIsolationGetAppContainerConfig returned missing entries");
    }
    let mut exempt = false;
    if !entries.is_null() {
        let slice = unsafe { std::slice::from_raw_parts(entries, count as usize) };
        let entry_sids = slice
            .iter()
            .map(|entry| entry.Sid.cast::<c_void>())
            .collect::<Vec<_>>();
        if entry_sids.iter().all(|sid| !sid.is_null()) {
            exempt = slice
                .iter()
                .any(|entry| unsafe { EqualSid(entry.Sid, package_sid) } != 0);
        }
        let released = release_network_isolation_allocations(
            &entry_sids,
            entries.cast(),
            |allocation| unsafe { HeapFree(GetProcessHeap(), 0, allocation) != 0 },
        );
        if !released {
            return Err("NetworkIsolation entries HeapFree(GetProcessHeap) failed");
        }
    }
    if exempt {
        return Err("fixed package SID is loopback exempt");
    }
    Ok(())
}

#[cfg(windows)]
#[derive(Debug)]
struct NativePipeHandles {
    parent_stdin_write: Option<OwnedNativeHandle>,
    parent_stdout_read: OwnedNativeHandle,
    parent_stderr_read: OwnedNativeHandle,
    child_stdin_read: Option<OwnedNativeHandle>,
    child_stdout_write: Option<OwnedNativeHandle>,
    child_stderr_write: Option<OwnedNativeHandle>,
}

#[cfg(windows)]
impl NativePipeHandles {
    fn child_handle_list(&self) -> Result<[HANDLE; EXACT_INHERITED_HANDLE_COUNT], &'static str> {
        let stdin = self
            .child_stdin_read
            .as_ref()
            .ok_or("stdin child end absent")?;
        let stdout = self
            .child_stdout_write
            .as_ref()
            .ok_or("stdout child end absent")?;
        let stderr = self
            .child_stderr_write
            .as_ref()
            .ok_or("stderr child end absent")?;
        if stdin.kind() != TypedHandleKind::StdinRead
            || stdout.kind() != TypedHandleKind::StdoutWrite
            || stderr.kind() != TypedHandleKind::StderrWrite
        {
            return Err("typed inherited handle role drift");
        }
        Ok([stdin.raw(), stdout.raw(), stderr.raw()])
    }

    fn close_child_ends(&mut self) {
        drop(self.child_stdin_read.take());
        drop(self.child_stdout_write.take());
        drop(self.child_stderr_write.take());
    }
}

#[cfg(windows)]
fn native_pipe_pair(
    name: &str,
    parent_reads: bool,
    parent_kind: TypedHandleKind,
    child_kind: TypedHandleKind,
) -> Result<(OwnedNativeHandle, OwnedNativeHandle), &'static str> {
    let name = wide(name);
    let access = if parent_reads {
        PIPE_ACCESS_INBOUND
    } else {
        PIPE_ACCESS_OUTBOUND
    } | FILE_FLAG_OVERLAPPED
        | FILE_FLAG_FIRST_PIPE_INSTANCE;
    let parent = OwnedNativeHandle::new(
        unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                access,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                (MAX_STDOUT_BYTES + 1) as u32,
                (MAX_STDOUT_BYTES + 1) as u32,
                0,
                null(),
            )
        },
        parent_kind,
    )
    .map_err(|_| "CreateNamedPipeW failed")?;
    if unsafe { SetHandleInformation(parent.raw(), HANDLE_FLAG_INHERIT, 0) } == 0 {
        return Err("parent pipe inherit-clear failed");
    }
    let mut security: SECURITY_ATTRIBUTES = unsafe { zeroed() };
    security.nLength = size_of::<SECURITY_ATTRIBUTES>() as u32;
    security.bInheritHandle = 1;
    let child = OwnedNativeHandle::new(
        unsafe {
            CreateFileW(
                name.as_ptr(),
                if parent_reads {
                    GENERIC_WRITE
                } else {
                    GENERIC_READ
                },
                0,
                &security,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                null_mut(),
            )
        },
        child_kind,
    )
    .map_err(|_| "named-pipe child CreateFileW failed")?;
    let mut child_flags = 0u32;
    if unsafe { GetHandleInformation(child.raw(), &mut child_flags) } == 0
        || child_flags & HANDLE_FLAG_INHERIT == 0
    {
        return Err("child pipe end is not inheritable");
    }
    let connect_event = OwnedNativeHandle::new(
        unsafe { CreateEventW(null(), 1, 0, null()) },
        TypedHandleKind::OverlappedEvent,
    )
    .map_err(|_| "CreateEventW for ConnectNamedPipe failed")?;
    let mut connect_overlapped: OVERLAPPED = unsafe { zeroed() };
    connect_overlapped.hEvent = connect_event.raw();
    let connected = unsafe { ConnectNamedPipe(parent.raw(), &mut connect_overlapped) };
    if connected == 0 {
        let error = unsafe { GetLastError() };
        if error != ERROR_PIPE_CONNECTED {
            return Err("ConnectNamedPipe did not observe the connected fixed client");
        }
    }
    Ok((parent, child))
}

#[cfg(windows)]
fn native_create_pipes(
    context: &ProductionInvocationContext,
) -> Result<NativePipeHandles, &'static str> {
    let prefix = format!(
        r"\\.\pipe\DecadansNeurobro-rm0032-{}",
        context.ledger_identity_sha256
    );
    let (parent_stdin_write, child_stdin_read) = native_pipe_pair(
        &format!("{prefix}-stdin-v1"),
        false,
        TypedHandleKind::StdinWrite,
        TypedHandleKind::StdinRead,
    )?;
    let (parent_stdout_read, child_stdout_write) = native_pipe_pair(
        &format!("{prefix}-stdout-v1"),
        true,
        TypedHandleKind::StdoutRead,
        TypedHandleKind::StdoutWrite,
    )?;
    let (parent_stderr_read, child_stderr_write) = native_pipe_pair(
        &format!("{prefix}-stderr-v1"),
        true,
        TypedHandleKind::StderrRead,
        TypedHandleKind::StderrWrite,
    )?;
    Ok(NativePipeHandles {
        parent_stdin_write: Some(parent_stdin_write),
        parent_stdout_read,
        parent_stderr_read,
        child_stdin_read: Some(child_stdin_read),
        child_stdout_write: Some(child_stdout_write),
        child_stderr_write: Some(child_stderr_write),
    })
}

#[cfg(windows)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum NativeIoDirection {
    Read,
    Write,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeOperationState {
    Prepared,
    Pending,
    Immediate(u32),
    Terminal(u32),
    TerminalError(u32),
    // Created only by initial WriteFile returning ERROR_NO_DATA before pending.
    InitialWriteNoData,
    CancelRequested,
    Retired,
}

pub fn initial_write_no_data_retirement(state: NativeOperationState) -> bool {
    state == NativeOperationState::InitialWriteNoData
}

#[cfg(windows)]
struct NativePendingIo {
    handle: HANDLE,
    event: OwnedNativeHandle,
    overlapped: Box<OVERLAPPED>,
    buffer: Vec<u8>,
    direction: NativeIoDirection,
    state: NativeOperationState,
    failure: Option<(IoDiagnosticApi, u32)>,
    submitted_once: bool,
}

#[cfg(windows)]
impl NativePendingIo {
    fn prepared(
        handle: HANDLE,
        direction: NativeIoDirection,
        buffer: Vec<u8>,
    ) -> Result<Self, &'static str> {
        let event = OwnedNativeHandle::new(
            unsafe { CreateEventW(null(), 1, 0, null()) },
            TypedHandleKind::OverlappedEvent,
        )
        .map_err(|_| "CreateEventW for OVERLAPPED failed")?;
        let mut overlapped: Box<OVERLAPPED> = Box::new(unsafe { zeroed() });
        overlapped.hEvent = event.raw();
        Ok(Self {
            handle,
            event,
            overlapped,
            buffer,
            direction,
            state: NativeOperationState::Prepared,
            failure: None,
            submitted_once: false,
        })
    }

    fn submit(&mut self) -> Result<(), &'static str> {
        if self.state != NativeOperationState::Prepared {
            return Err("OVERLAPPED operation was not prepared for submission");
        }
        let initial_submit = !self.submitted_once;
        self.submitted_once = true;
        let mut immediate = 0u32;
        let ok = unsafe {
            match self.direction {
                NativeIoDirection::Read => ReadFile(
                    self.handle,
                    self.buffer.as_mut_ptr().cast(),
                    self.buffer.len() as u32,
                    &mut immediate,
                    &mut *self.overlapped,
                ),
                NativeIoDirection::Write => WriteFile(
                    self.handle,
                    self.buffer.as_ptr().cast(),
                    self.buffer.len() as u32,
                    &mut immediate,
                    &mut *self.overlapped,
                ),
            }
        };
        if ok != 0 {
            self.state = NativeOperationState::Immediate(immediate);
            return Ok(());
        }
        let error = unsafe { GetLastError() };
        if error != ERROR_IO_PENDING && !(error == ERROR_BROKEN_PIPE && self.direction == NativeIoDirection::Read) {
            self.failure = Some((match self.direction {
                NativeIoDirection::Read => IoDiagnosticApi::ReadSubmit,
                NativeIoDirection::Write => IoDiagnosticApi::WriteSubmit,
            }, error));
        }
        self.state = match error {
            ERROR_IO_PENDING => NativeOperationState::Pending,
            232 if initial_submit && self.direction == NativeIoDirection::Write => NativeOperationState::InitialWriteNoData,
            ERROR_BROKEN_PIPE if self.direction == NativeIoDirection::Read => {
                NativeOperationState::Terminal(0)
            }
            _ => NativeOperationState::TerminalError(error),
        };
        if matches!(
            self.state,
            NativeOperationState::Pending | NativeOperationState::Terminal(0)
        ) {
            Ok(())
        } else {
            Err("overlapped named-pipe operation submit failed conclusively")
        }
    }

    fn finish(&mut self, timeout_ms: u32) -> Result<u32, u32> {
        match self.state {
            NativeOperationState::Immediate(bytes) | NativeOperationState::Terminal(bytes) => {
                self.state = NativeOperationState::Terminal(bytes);
                return Ok(bytes);
            }
            NativeOperationState::TerminalError(error) => return Err(error),
            NativeOperationState::InitialWriteNoData => return Err(232),
            NativeOperationState::Prepared => return Err(ERROR_IO_INCOMPLETE),
            NativeOperationState::Retired => return Err(ERROR_OPERATION_ABORTED),
            NativeOperationState::Pending | NativeOperationState::CancelRequested => {}
        }
        match native_budgeted_wait(self.event.raw(), timeout_ms) {
            WAIT_OBJECT_0 => {}
            WAIT_TIMEOUT => {
                self.failure.get_or_insert((IoDiagnosticApi::Wait, WAIT_TIMEOUT));
                return Err(WAIT_TIMEOUT);
            }
            _ => {
                let error = unsafe { GetLastError() };
                self.failure.get_or_insert((IoDiagnosticApi::Wait, error));
                return Err(error);
            }
        }
        let mut transferred = 0u32;
        if unsafe { GetOverlappedResult(self.handle, &*self.overlapped, &mut transferred, 0) } == 0
        {
            let error = unsafe { GetLastError() };
            if error != ERROR_BROKEN_PIPE {
                self.failure.get_or_insert((IoDiagnosticApi::Completion, error));
            }
            if self.direction == NativeIoDirection::Read && error == ERROR_BROKEN_PIPE {
                self.state = NativeOperationState::Terminal(0);
                return Ok(0);
            }
            if error == ERROR_IO_INCOMPLETE {
                return Err(error);
            }
            self.state = NativeOperationState::TerminalError(error);
            return Err(error);
        }
        self.state = NativeOperationState::Terminal(transferred);
        Ok(transferred)
    }

    fn cancel(&mut self) -> Result<(), &'static str> {
        if !matches!(
            self.state,
            NativeOperationState::Pending | NativeOperationState::CancelRequested
        ) {
            return Ok(());
        }
        if unsafe { CancelIoEx(self.handle, &*self.overlapped) } == 0 {
            let error = unsafe { GetLastError() };
            if error != ERROR_NOT_FOUND {
                self.failure.get_or_insert((IoDiagnosticApi::Cancel, error));
                return Err("CancelIoEx failed");
            }
        }
        self.state = NativeOperationState::CancelRequested;
        Ok(())
    }

    fn prepare_next_read(&mut self, bytes: usize) -> Result<(), &'static str> {
        if !matches!(
            self.state,
            NativeOperationState::Terminal(_) | NativeOperationState::TerminalError(_)
        ) {
            return Err("previous OVERLAPPED read has not reached terminal completion");
        }
        if unsafe { ResetEvent(self.event.raw()) } == 0 {
            return Err("ResetEvent for OVERLAPPED read failed");
        }
        self.buffer = vec![0u8; bytes];
        self.overlapped = Box::new(unsafe { zeroed() });
        self.overlapped.hEvent = self.event.raw();
        self.state = NativeOperationState::Prepared;
        self.submit()
    }

    fn is_terminal(&self) -> bool {
        matches!(
            self.state,
            NativeOperationState::Terminal(_) | NativeOperationState::TerminalError(_) | NativeOperationState::InitialWriteNoData
        )
    }

    fn mark_retired(&mut self) -> Result<(), &'static str> {
        if !matches!(self.state, NativeOperationState::Prepared) && !self.is_terminal() {
            return Err("OVERLAPPED operation is not terminal for retirement");
        }
        self.state = NativeOperationState::Retired;
        Ok(())
    }
}

#[cfg(windows)]
fn native_budgeted_wait(handle: HANDLE, timeout: u32) -> u32 {
    let result = unsafe { WaitForSingleObject(handle, timeout) };
    #[cfg(test)]
    native_budget_fixture_hook::observed(handle, timeout, result);
    result
}

#[cfg(all(windows, test))]
mod native_budget_fixture_hook {
    use super::*;
    #[derive(Default)]
    struct State {
        record_waits: bool,
        elapsed: Option<u64>,
        advances: std::collections::VecDeque<u64>,
        waits: Vec<(usize, u32, u32)>,
    }
    thread_local! { static STATE: std::cell::RefCell<State> = std::cell::RefCell::new(State::default()); }
    pub fn arm(elapsed: u64, advances: &[u64]) {
        STATE.with(|s| {
            *s.borrow_mut() = State {
                record_waits: true,
                elapsed: Some(elapsed),
                advances: advances.iter().copied().collect(),
                waits: vec![],
            }
        });
    }
    pub fn observe_actual() {
        STATE.with(|s| {
            *s.borrow_mut() = State {
                record_waits: true,
                ..State::default()
            }
        });
    }
    pub fn elapsed(actual: u64) -> u64 {
        STATE.with(|s| s.borrow().elapsed.unwrap_or(actual))
    }
    pub fn observed(handle: HANDLE, timeout: u32, result: u32) {
        STATE.with(|s| {
            let mut s = s.borrow_mut();
            if s.record_waits {
                s.waits.push((handle as usize, timeout, result));
                if let Some(next) = s.advances.pop_front() {
                    s.elapsed = Some(next);
                }
            }
        });
    }
    pub fn take() -> Vec<(usize, u32, u32)> {
        STATE.with(|s| std::mem::take(&mut *s.borrow_mut()).waits)
    }
}

#[cfg(windows)]
struct NativeIoBundle {
    stdin: Option<NativePendingIo>,
    stdout: Option<NativePendingIo>,
    stderr: Option<NativePendingIo>,
    stdout_bytes: Vec<u8>,
    stderr_bytes: Vec<u8>,
    stdin_state: PipeState,
    stdout_state: PipeState,
    stderr_state: PipeState,
    stdout_eof: bool,
    stdout_cap_exceeded: bool,
    stderr_eof: bool,
    stderr_nonzero_seen: bool,
    retired: bool,
}

#[cfg(windows)]
#[derive(Debug)]
struct NativeChild {
    process: OwnedNativeHandle,
    thread: OwnedNativeHandle,
    process_id: u32,
    kind: ChildKind,
    assigned: bool,
    resumed: bool,
    containment: ContainmentState,
}

#[cfg(windows)]
struct NativeAttributeList {
    storage: Vec<u8>,
    pointer: windows_sys::Win32::System::Threading::LPPROC_THREAD_ATTRIBUTE_LIST,
}

#[cfg(windows)]
impl NativeAttributeList {
    fn new(count: u32) -> Result<Self, &'static str> {
        let mut bytes = 0usize;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), count, 0, &mut bytes);
        }
        if bytes == 0 || bytes > 1024 * 1024 {
            return Err("attribute-list size query failed");
        }
        let mut storage = vec![0u8; bytes];
        let pointer = storage.as_mut_ptr().cast();
        if unsafe { InitializeProcThreadAttributeList(pointer, count, 0, &mut bytes) } == 0 {
            return Err("InitializeProcThreadAttributeList failed");
        }
        Ok(Self { storage, pointer })
    }

    fn update(
        &mut self,
        attribute: usize,
        value: *const c_void,
        bytes: usize,
    ) -> Result<(), &'static str> {
        if unsafe {
            UpdateProcThreadAttribute(self.pointer, 0, attribute, value, bytes, null_mut(), null())
        } == 0
        {
            return Err("UpdateProcThreadAttribute failed");
        }
        Ok(())
    }
}

#[cfg(windows)]
impl Drop for NativeAttributeList {
    fn drop(&mut self) {
        if !self.pointer.is_null() {
            unsafe {
                DeleteProcThreadAttributeList(self.pointer);
            }
            self.pointer = null_mut();
        }
        self.storage.clear();
    }
}

#[cfg(windows)]
fn fixed_environment_block() -> Result<Vec<u16>, &'static str> {
    let mut block = Vec::new();
    for (key, expected) in EXACT_ENVIRONMENT {
        let key_wide = wide(key);
        let required = unsafe { GetEnvironmentVariableW(key_wide.as_ptr(), null_mut(), 0) };
        if required == 0 || required > 32_767 {
            return Err("required environment variable is absent or oversized");
        }
        let mut value = vec![0u16; required as usize];
        let written = unsafe {
            GetEnvironmentVariableW(key_wide.as_ptr(), value.as_mut_ptr(), value.len() as u32)
        };
        if written == 0 || written as usize >= value.len() {
            return Err("required environment variable read failed");
        }
        value.truncate(written as usize);
        if String::from_utf16(&value).map_err(|_| "required environment variable is not UTF-16")?
            != expected
        {
            return Err("required environment variable differs from fixed per-key value");
        }
        block.extend(key.encode_utf16());
        block.push('=' as u16);
        block.extend(expected.encode_utf16());
        block.push(0);
    }
    block.push(0);
    Ok(block)
}

// Test-only access to the actual production helpers: API-only subprocesses
// never acquire tokens, open product paths, create ledgers or launch workloads.
#[cfg(all(windows, test))]
pub(crate) fn fixture_fixed_environment_block() -> Result<Vec<u16>, &'static str> {
    fixed_environment_block()
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeCreateError {
    Precondition(&'static str),
    False { kind: ChildKind, win32_error: u32 },
}

impl From<&'static str> for NativeCreateError {
    fn from(reason: &'static str) -> Self {
        Self::Precondition(reason)
    }
}

pub(crate) fn native_create_reply(result: Result<(), NativeCreateError>) -> KernelReply {
    match result {
        Ok(()) => KernelReply::CreateTrue {
            process_info_valid: true,
        },
        Err(NativeCreateError::False { kind, win32_error }) => {
            KernelReply::CreateFalseTrustworthy { kind, win32_error }
        }
        Err(NativeCreateError::Precondition(
            "CreateProcessAsUserW TRUE returned malformed PROCESS_INFORMATION after bounded containment",
        ))
        | Err(NativeCreateError::Precondition(
            "CreateProcessAsUserW TRUE returned malformed PROCESS_INFORMATION with containment unknown",
        )) => KernelReply::Unknown("CreateProcess TRUE malformed PROCESS_INFORMATION"),
        Err(NativeCreateError::Precondition(reason)) => KernelReply::Failed(reason),
    }
}

fn create_false_reason(kind: ChildKind, win32_error: u32) -> String {
    let role = match kind {
        ChildKind::Worker => "worker",
        ChildKind::Observer => "observer",
    };
    let availability = if win32_error == 0 {
        "; cause-unavailable"
    } else {
        ""
    };
    format!("CreateProcessAsUserW FALSE; role={role}; win32-error={win32_error}{availability}")
}

#[cfg(windows)]
pub(crate) struct LocalDirectoryObservation {
    pub final_path: String,
    pub directory: bool,
    pub delete_pending: bool,
    pub reparse: bool,
}

// The provider boundary is shared by the production builder and hostile tests.
// It supplies observations, not an alternative policy or child-create callback.
#[cfg(windows)]
pub(crate) trait ChildEnvironmentProvider {
    fn local_app_data(&mut self) -> Result<Option<Vec<u16>>, &'static str>;
    fn directory(&mut self, path: &str) -> Result<LocalDirectoryObservation, &'static str>;
}

#[cfg(windows)]
struct NativeChildEnvironment;

#[cfg(windows)]
impl ChildEnvironmentProvider for NativeChildEnvironment {
    fn local_app_data(&mut self) -> Result<Option<Vec<u16>>, &'static str> {
        let mut raw = null_mut();
        // Current worker caller, not its separate restricted/Low observer token.
        // Flags zero never asks to create a profile or a missing folder.
        let status =
            unsafe { SHGetKnownFolderPath(&FOLDERID_LocalAppData, 0, null_mut(), &mut raw) };
        let allocation = OwnedCoTaskMemWide(raw);
        if status < 0 {
            return Err("LocalAppData KnownFolder query failed");
        }
        if allocation.0.is_null() {
            return Ok(None);
        }
        let mut length = 0usize;
        while length < 32_767 && unsafe { *allocation.0.add(length) } != 0 {
            length += 1;
        }
        if length == 32_767 {
            return Err("LocalAppData KnownFolder path is oversized");
        }
        Ok(Some(
            unsafe { std::slice::from_raw_parts(allocation.0, length) }.to_vec(),
        ))
    }

    fn directory(&mut self, path: &str) -> Result<LocalDirectoryObservation, &'static str> {
        let handle = OwnedNativeHandle::new(
            unsafe {
                CreateFileW(
                    wide(path).as_ptr(),
                    FILE_READ_ATTRIBUTES,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    null(),
                    OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                    null_mut(),
                )
            },
            TypedHandleKind::HeldAncestor,
        )
        .map_err(|_| "LocalAppData directory open refused")?;
        let final_path =
            native_final_path(handle.raw()).map_err(|_| "LocalAppData final path unavailable")?;
        let standard: FILE_STANDARD_INFO = native_file_info(handle.raw(), FileStandardInfo)
            .map_err(|_| "LocalAppData directory information unavailable")?;
        let basic: FILE_BASIC_INFO = native_file_info(handle.raw(), FileBasicInfo)
            .map_err(|_| "LocalAppData attributes unavailable")?;
        Ok(LocalDirectoryObservation {
            final_path,
            directory: standard.Directory,
            delete_pending: standard.DeletePending,
            reparse: basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0,
        })
    }
}

#[cfg(windows)]
fn child_environment<P: ChildEnvironmentProvider>(
    kind: ChildKind,
    provider: &mut P,
    binding: Option<&GeneratedDriveBinding>,
) -> Result<Vec<u16>, &'static str> {
    let original = fixed_environment_block()?;
    if kind == ChildKind::Worker {
        if binding.is_some() { return Err("Worker environment must not have Observer drive binding"); }
        return Ok(original);
    }
    let binding = binding.ok_or("Observer drive binding missing")?;
    let units = provider
        .local_app_data()?
        .ok_or("LocalAppData KnownFolder returned null")?;
    if units.is_empty() || units.len() >= 32_767 || units.contains(&0) {
        return Err("LocalAppData KnownFolder path length or terminator refused");
    }
    let path = String::from_utf16(&units).map_err(|_| "LocalAppData path is not UTF-16")?;
    let bytes = path.as_bytes();
    if bytes.len() < 4 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' || bytes[2] != b'\\' {
        return Err("LocalAppData absolute local DOS path required");
    }
    let parts: Vec<_> = path[3..].split('\\').collect();
    if parts.iter().any(|part| {
        part.is_empty()
            || *part == "."
            || *part == ".."
            || part.ends_with('.')
            || part.ends_with(' ')
            || part
                .chars()
                .any(|c| c.is_control() || "/:\"<>|?*".contains(c))
    }) {
        return Err("LocalAppData canonical path components required");
    }
    // Read-only observations of every component, including the drive root.
    // Share-all handles are released: this does not freeze the trusted user's
    // profile namespace or prove the child's eventual access to that folder.
    let mut prefix = path[..3].to_owned();
    for component in std::iter::once(None).chain(parts.iter().map(|part| Some(*part))) {
        if let Some(component) = component {
            if !prefix.ends_with('\\') {
                prefix.push('\\');
            }
            prefix.push_str(component);
        }
        let expected = format!(r"\\?\{prefix}");
        let observed = provider.directory(&expected)?;
        if observed.final_path != expected
            || !observed.directory
            || observed.delete_pending
            || observed.reparse
        {
            return Err("LocalAppData directory readback refused");
        }
    }
    let mut block: Vec<_> = format!("{OBSERVER_DRIVE_BINDING_KEY}={}", binding.canonical_record())
        .encode_utf16().chain(std::iter::once(0)).collect();
    block.extend("LOCALAPPDATA="
        .encode_utf16()
        .chain(units)
        .chain(std::iter::once(0)));
    block.extend_from_slice(&original);
    if block.len() > 32_767 {
        return Err("observer child environment exceeds the fixed size bound");
    }
    Ok(block)
}

#[cfg(windows)]
pub(crate) fn with_child_environment<P: ChildEnvironmentProvider, T>(
    kind: ChildKind,
    provider: &mut P,
    binding: Option<&GeneratedDriveBinding>,
    create: impl FnOnce(&[u16]) -> Result<T, NativeCreateError>,
) -> Result<T, NativeCreateError> {
    let block = child_environment(kind, provider, binding)?;
    create(&block)
}

#[cfg(all(windows, test))]
pub(crate) fn fixture_child_environment(kind: ChildKind) -> Result<Vec<u16>, NativeCreateError> {
    let binding = fixture_generated_drive_binding();
    with_child_environment(
        kind,
        &mut NativeChildEnvironment,
        (kind == ChildKind::Observer).then_some(&binding),
        |block| Ok(block.to_vec()),
    )
}

#[cfg(test)]
pub fn fixture_generated_drive_binding() -> GeneratedDriveBinding {
    GeneratedDriveBinding::from_observation("C:", &"a".repeat(64), &DriveAnchorObservation {
        normalized_dos: r"\\?\C:\".into(), normalized_nt: r"\Device\HarddiskVolume1\".into(),
        volume_serial: 1, file_id: [1; 16], directory: true, delete_pending: false, reparse: false,
    }).expect("closed synthetic observation")
}

#[cfg(windows)]
pub(crate) fn capture_native_create(
    kind: ChildKind,
    create: impl FnOnce() -> i32,
) -> Result<(), NativeCreateError> {
    unsafe {
        SetLastError(0);
    }
    let created = create(); // Production closure contains only the actual FFI call.
    if created == 0 {
        // First Win32 observation on FALSE, before any owner/attribute cleanup.
        let win32_error = unsafe { GetLastError() };
        return Err(NativeCreateError::False { kind, win32_error });
    }
    Ok(()) // LastError has no meaning after TRUE.
}

#[cfg(all(windows, test))]
pub(crate) fn fixture_verify_program_data_binding() -> Result<(), &'static str> {
    native_verify_program_data_binding()
}

#[cfg(all(windows, test))]
pub(crate) fn fixture_validate_environment_binding() -> Vec<KernelReply> {
    let supervisor = native_privilege_boundary_tests::context();
    let worker = parse_production_input(
        Mode::Worker,
        &supervisor.supervisor_handoff_bytes().unwrap(),
    )
    .unwrap();
    [supervisor, worker]
        .into_iter()
        .map(|context| {
            let before = native_ledger_security::fixture_create_call_count();
            // Install fixture context without bind_context's privilege acquisition.
            // Exercise only the real validation step, never the reducer/effect path.
            let mut kernel = RealWin32Kernel::default();
            kernel.context = Some(context);
            let reply = kernel.invoke(Step::ValidateFixedBinding);
            assert_eq!(kernel.calls, [Step::ValidateFixedBinding]);
            assert_eq!(native_ledger_security::fixture_create_call_count(), before);
            reply
        })
        .collect()
}

#[cfg(windows)]
fn native_create_child(
    kind: ChildKind,
    token: HANDLE,
    pipes: &NativePipeHandles,
    package_sid: Option<&OwnedDerivedSid>,
    binding: Option<&GeneratedDriveBinding>,
) -> Result<NativeChild, NativeCreateError> {
    with_child_environment(kind, &mut NativeChildEnvironment, binding, |environment| {
        native_create_child_with_environment(kind, token, pipes, package_sid, environment)
    })
}

#[cfg(windows)]
fn native_create_child_with_environment(
    kind: ChildKind,
    token: HANDLE,
    pipes: &NativePipeHandles,
    package_sid: Option<&OwnedDerivedSid>,
    environment: &[u16],
) -> Result<NativeChild, NativeCreateError> {
    let spec = fixed_native_launch_spec(kind);
    verify_observer_startup_binding(kind, spec.creation_flags, spec.cwd)?;
    let handles = pipes.child_handle_list()?;
    if spec.inherited_handle_count != handles.len() || !spec.inherit_handles {
        return Err("fixed native launch handle contract drifted".into());
    }
    if handles.iter().any(|handle| handle.is_null())
        || handles[0] == handles[1]
        || handles[0] == handles[2]
        || handles[1] == handles[2]
    {
        return Err("exact inherited handle list contains null or aliases".into());
    }
    let mut attributes = NativeAttributeList::new(spec.attribute_count)?;
    attributes.update(
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
        handles.as_ptr().cast(),
        size_of::<[HANDLE; EXACT_INHERITED_HANDLE_COUNT]>(),
    )?;
    let security_capabilities;
    if kind == ChildKind::Observer {
        let sid = package_sid.ok_or("observer AppContainer SID absent")?;
        security_capabilities = SECURITY_CAPABILITIES {
            AppContainerSid: sid.0,
            Capabilities: null_mut(),
            CapabilityCount: 0,
            Reserved: 0,
        };
        attributes.update(
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
            (&security_capabilities as *const SECURITY_CAPABILITIES).cast(),
            size_of::<SECURITY_CAPABILITIES>(),
        )?;
    }
    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = spec.startup_info_flags;
    startup.StartupInfo.wShowWindow = 0;
    startup.StartupInfo.hStdInput = handles[0];
    startup.StartupInfo.hStdOutput = handles[1];
    startup.StartupInfo.hStdError = handles[2];
    startup.lpAttributeList = attributes.pointer;

    let application_wide = wide(spec.application);
    let mut command_line = wide(&format!("\"{}\" {}", spec.application, spec.mode));
    let cwd = wide(spec.cwd);
    let mut process_information: PROCESS_INFORMATION = unsafe { zeroed() };
    capture_native_create(kind, || unsafe {
        CreateProcessAsUserW(
            token,
            application_wide.as_ptr(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            i32::from(spec.inherit_handles),
            spec.creation_flags,
            environment.as_ptr().cast(),
            cwd.as_ptr(),
            &startup.StartupInfo,
            &mut process_information,
        )
    })?;
    let disposition = classify_process_information(
        !process_information.hProcess.is_null(),
        !process_information.hThread.is_null(),
        process_information.hProcess == process_information.hThread,
        process_information.dwProcessId,
        process_information.dwThreadId,
    );
    if disposition != ProcessInformationDisposition::Valid {
        let process_contained =
            if disposition == ProcessInformationDisposition::MalformedWithProcessHandle {
                (unsafe { TerminateProcess(process_information.hProcess, 0xE003_2003) }) != 0
                    && (unsafe {
                        WaitForSingleObject(process_information.hProcess, DRAIN_GRACE_MS as u32)
                    }) == WAIT_OBJECT_0
            } else {
                false
            };
        if !process_information.hProcess.is_null() {
            unsafe {
                CloseHandle(process_information.hProcess);
            }
        }
        if !process_information.hThread.is_null()
            && process_information.hThread != process_information.hProcess
        {
            unsafe {
                CloseHandle(process_information.hThread);
            }
        }
        return Err(NativeCreateError::Precondition(if process_contained {
            "CreateProcessAsUserW TRUE returned malformed PROCESS_INFORMATION after bounded containment"
        } else {
            "CreateProcessAsUserW TRUE returned malformed PROCESS_INFORMATION with containment unknown"
        }));
    }
    Ok(NativeChild {
        process: OwnedNativeHandle {
            raw: process_information.hProcess,
            kind: TypedHandleKind::Process,
        },
        thread: OwnedNativeHandle {
            raw: process_information.hThread,
            kind: TypedHandleKind::Thread,
        },
        process_id: process_information.dwProcessId,
        kind,
        assigned: false,
        resumed: false,
        containment: ContainmentState::SuspendedUnassigned,
    })
}

#[cfg(windows)]
fn native_process_image_path(process: HANDLE) -> Result<String, &'static str> {
    let mut buffer = vec![0u16; 32_768];
    let mut length = buffer.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length) } == 0
        || length == 0
    {
        return Err("QueryFullProcessImageNameW failed");
    }
    let path = String::from_utf16(&buffer[..length as usize])
        .map_err(|_| "process image path was not UTF-16")?;
    if path.starts_with(r"\\?\") {
        Ok(path)
    } else if path.len() >= 3 && path.as_bytes()[1] == b':' && path.as_bytes()[2] == b'\\' {
        Ok(format!(r"\\?\{path}"))
    } else {
        Err("process image path was not an absolute DOS path")
    }
}

#[cfg(windows)]
fn native_verify_child_image(
    child: &NativeChild,
    held: &HeldNativeFile,
) -> Result<(), &'static str> {
    let process_path = native_process_image_path(child.process.raw())?;
    if process_path != held.snapshot.final_path {
        return Err("process image query mismatched held image final path");
    }
    let reopened = open_native_file(&process_path, false, false, TypedHandleKind::HeldImage)?;
    if !reopened.snapshot.stable_integrity_matches(&held.snapshot) {
        return Err("process image reopen identity/hash/security mismatch");
    }
    Ok(())
}

/// Closed AccessCheck acquisition result. SID and descriptor contents never leave
/// the native acquisition helper. API success is distinct from access granted.
#[derive(Clone, Debug)]
pub struct AppContainerAccessRow {
    pub api_succeeded: bool,
    pub requested_mask: u32,
    pub access_status: bool,
    pub granted_mask: u32,
    pub privilege_storage: Vec<u8>,
    pub returned_privilege_bytes: usize,
    pub immediate_error: u32,
}

impl AppContainerAccessRow {
    fn matches(&self, allowed: bool) -> bool {
        // PRIVILEGE_SET has two DWORDs followed by LUID_AND_ATTRIBUTES (12 bytes).
        // Validate the complete returned shape before trusting even a zero count.
        let Some(bytes) = self.privilege_storage.get(..self.returned_privilege_bytes) else {
            return false;
        };
        if !self.api_succeeded || bytes.len() < 8 { return false; }
        let count = u32::from_ne_bytes(bytes[..4].try_into().unwrap()) as usize;
        let valid = count.checked_mul(12).and_then(|n| n.checked_add(8))
            .is_some_and(|end| end <= bytes.len());
        valid && count == 0 && self.requested_mask == 1
            && self.access_status == allowed && self.granted_mask == if allowed { 1 } else { 0 }
    }
}

pub fn verify_appcontainer_access_baseline(
    acquire: impl FnOnce() -> Result<[AppContainerAccessRow; 3], &'static str>,
) -> Result<(), &'static str> {
    let rows = acquire()?;
    if !rows[0].matches(false) || !rows[1].matches(true) || !rows[2].matches(true) {
        return Err("observer token effective ALL APPLICATION PACKAGES baseline refused");
    }
    Ok(())
}

#[cfg(windows)]
fn native_appcontainer_access_row(token: HANDLE, descriptor_text: &str)
    -> Result<AppContainerAccessRow, &'static str>
{
    let text = wide(descriptor_text);
    let mut descriptor = null_mut();
    if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(text.as_ptr(), 1,
        &mut descriptor, null_mut()) } == 0 {
        return Err("AAP in-memory descriptor conversion failed");
    }
    let _owner = OwnedLocalAllocation(descriptor);
    let mut present = 0;
    let mut dacl = null_mut();
    let mut defaulted = 0;
    if unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) } == 0
        || present == 0 || dacl.is_null() {
        return Err("AAP in-memory descriptor DACL invalid");
    }
    let mapping = GENERIC_MAPPING { GenericRead: 1, GenericWrite: 2, GenericExecute: 4, GenericAll: 7 };
    let mut desired = GENERIC_READ;
    unsafe { MapGenericMask(&mut desired, &mapping) };
    if desired != 1 { return Err("AAP requested access mask invalid"); }
    let mut storage = [0usize; 128];
    let mut length = size_of::<[usize; 128]>() as u32;
    let mut granted = 0;
    let mut access = 0;
    unsafe { SetLastError(0) };
    let ok = unsafe { AccessCheck(descriptor, token, desired, &mapping,
        storage.as_mut_ptr().cast::<PRIVILEGE_SET>(), &mut length, &mut granted, &mut access) };
    let immediate_error = unsafe { GetLastError() };
    let bytes = unsafe { std::slice::from_raw_parts(storage.as_ptr().cast::<u8>(),
        size_of::<[usize; 128]>()) }.to_vec();
    Ok(AppContainerAccessRow { api_succeeded: ok != 0, requested_mask: desired,
        access_status: access != 0, granted_mask: granted, privilege_storage: bytes,
        returned_privilege_bytes: length as usize, immediate_error })
}

#[cfg(windows)]
fn native_acquire_appcontainer_access(token: HANDLE, expected_sid: PSID)
    -> Result<[AppContainerAccessRow; 3], &'static str>
{
    let mut raw = null_mut();
    if unsafe { DuplicateTokenEx(token, TOKEN_QUERY, null(), SecurityImpersonation,
        TokenImpersonation, &mut raw) } == 0 {
        return Err("AAP query-only token duplication failed");
    }
    let duplicate = OwnedNativeHandle::new(raw, TypedHandleKind::Token)
        .map_err(|_| "AAP duplicate token handle invalid")?;
    let bytes = native_token_information(duplicate.raw(), TokenUser)?;
    if bytes.len() < size_of::<TOKEN_USER>() { return Err("AAP token user header invalid"); }
    let user = unsafe { bytes.as_ptr().cast::<TOKEN_USER>().read_unaligned() };
    let offset = (user.User.Sid as usize).checked_sub(bytes.as_ptr() as usize)
        .ok_or("AAP token user SID outside buffer")?;
    let header = bytes.get(offset..).and_then(|tail| tail.get(..8))
        .ok_or("AAP token user SID header invalid")?;
    if offset.checked_add(8 + 4 * header[1] as usize).is_none_or(|end| end > bytes.len())
        || unsafe { IsValidSid(user.User.Sid) } == 0 {
        return Err("AAP token user SID invalid");
    }
    let user_sid = sid_string(user.User.Sid)?;
    let package_sid = sid_string(expected_sid)?;
    // Fixed valid owner/group and non-NULL DACLs, in memory only. No owner
    // special rights, MAXIMUM_ALLOWED, object ACL mutation or impersonation.
    let ordinary = format!("O:SYG:SYD:P(A;;0x1;;;{user_sid})");
    Ok([
        native_appcontainer_access_row(duplicate.raw(), &ordinary)?,
        native_appcontainer_access_row(duplicate.raw(), &format!("{ordinary}(A;;0x1;;;{package_sid})"))?,
        native_appcontainer_access_row(duplicate.raw(), &format!("{ordinary}(A;;0x1;;;S-1-15-2-1)"))?,
    ])
}

#[cfg(windows)]
fn native_verify_process_appcontainer(
    process: HANDLE,
    expected_sid: PSID,
) -> Result<(), &'static str> {
    let mut raw = null_mut();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY | TOKEN_DUPLICATE, &mut raw) } == 0 {
        return Err("OpenProcessToken child query failed");
    }
    let token = OwnedNativeHandle::new(raw, TypedHandleKind::Token)
        .map_err(|_| "child token query handle invalid")?;
    let is_app = native_token_information(token.raw(), TokenIsAppContainer)?;
    if is_app.len() < size_of::<u32>() || unsafe { *(is_app.as_ptr().cast::<u32>()) } != 1 {
        return Err("observer token is not AppContainer");
    }
    let app_sid = native_token_information(token.raw(), TokenAppContainerSid)?;
    let app_info = unsafe { &*(app_sid.as_ptr().cast::<TOKEN_APPCONTAINER_INFORMATION>()) };
    if app_info.TokenAppContainer.is_null()
        || unsafe { EqualSid(app_info.TokenAppContainer, expected_sid) } == 0
    {
        return Err("observer token AppContainer SID mismatch");
    }
    let capabilities = native_token_information(token.raw(), TokenCapabilities)?;
    let capabilities = unsafe { &*(capabilities.as_ptr().cast::<TOKEN_GROUPS>()) };
    if capabilities.GroupCount != 0 {
        return Err("observer token has nonzero AppContainer capabilities");
    }
    verify_appcontainer_access_baseline(|| native_acquire_appcontainer_access(token.raw(), expected_sid))?;
    let integrity = native_token_information(token.raw(), TokenIntegrityLevel)?;
    let label = unsafe { &*(integrity.as_ptr().cast::<TOKEN_MANDATORY_LABEL>()) };
    if sid_string(label.Label.Sid)? != "S-1-16-4096" {
        return Err("observer process token is not low integrity");
    }
    Ok(())
}

#[cfg(all(windows, test))]
pub(crate) mod native_appcontainer_access_fixture {
    use super::*;

    pub fn ordinary_token_and_invalid_acquisition_refuse() {
        assert_eq!(std::mem::offset_of!(PRIVILEGE_SET, Privilege), 8);
        assert_eq!(size_of::<LUID_AND_ATTRIBUTES>(), 12);
        let mut sid = null_mut();
        assert_ne!(unsafe { ConvertStringSidToSidW(wide("S-1-15-2-424242").as_ptr(), &mut sid) }, 0);
        let _sid = OwnedLocalAllocation(sid);
        let mut raw = null_mut();
        assert_ne!(unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &mut raw) }, 0);
        let token = OwnedNativeHandle::new(raw, TypedHandleKind::Token).unwrap();
        let is_app = native_token_information(token.raw(), TokenIsAppContainer).unwrap();
        assert_eq!(u32::from_ne_bytes(is_app[..4].try_into().unwrap()), 0);
        let rows = native_acquire_appcontainer_access(token.raw(), sid).unwrap();
        // An ordinary token must grant user-only access, falsifying the required
        // AppContainer negative control through the actual acquisition helper.
        assert!(rows[0].matches(true));
        assert!(verify_appcontainer_access_baseline(|| Ok(rows)).is_err());
        assert!(verify_appcontainer_access_baseline(|| native_acquire_appcontainer_access(null_mut(), sid)).is_err());
        assert_eq!(native_verify_process_appcontainer(unsafe { GetCurrentProcess() }, sid),
            Err("observer token is not AppContainer"));
        assert!(native_verify_process_appcontainer(null_mut(), sid).is_err());
    }
}

#[cfg(windows)]
fn native_verify_job_membership(process: HANDLE, job: HANDLE) -> Result<(), &'static str> {
    let mut contained = 0;
    if unsafe { IsProcessInJob(process, job, &mut contained) } == 0 || contained == 0 {
        return Err("IsProcessInJob did not verify containment");
    }
    Ok(())
}

#[cfg(windows)]
fn native_thread_count(process_id: u32) -> Result<u32, &'static str> {
    let snapshot = OwnedNativeHandle::new(
        unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) },
        TypedHandleKind::Snapshot,
    )
    .map_err(|_| "CreateToolhelp32Snapshot threads failed")?;
    let mut entry: THREADENTRY32 = unsafe { zeroed() };
    entry.dwSize = size_of::<THREADENTRY32>() as u32;
    let mut count = 0u32;
    if unsafe { Thread32First(snapshot.raw(), &mut entry) } != 0 {
        loop {
            if entry.th32OwnerProcessID == process_id {
                count = count.saturating_add(1);
            }
            if unsafe { Thread32Next(snapshot.raw(), &mut entry) } == 0 {
                break;
            }
        }
    }
    Ok(count)
}

pub struct RealWin32Kernel {
    pub calls: Vec<Step>,
    pub context: Option<ProductionInvocationContext>,
    #[cfg(windows)]
    launcher_image: Option<HeldNativeFile>,
    #[cfg(windows)]
    observer_image: Option<HeldNativeFile>,
    #[cfg(windows)]
    surfaces: Vec<HeldNativeSurface>,
    #[cfg(windows)]
    observer_cwd: Option<HeldObserverCwd>,
    #[cfg(windows)]
    ledger: Option<NativeLedger>,
    #[cfg(windows)]
    supervisor_ledger_evidence: Option<HeldNativeFile>,
    #[cfg(windows)]
    outer_job: Option<NativeJob>,
    #[cfg(windows)]
    inner_job: Option<NativeJob>,
    #[cfg(windows)]
    source_token: Option<OwnedNativeHandle>,
    #[cfg(windows)]
    restricted_token: Option<OwnedNativeHandle>,
    #[cfg(windows)]
    package_sid: Option<OwnedDerivedSid>,
    #[cfg(windows)]
    pipes: Option<NativePipeHandles>,
    #[cfg(windows)]
    io: Option<NativeIoBundle>,
    #[cfg(windows)]
    child: Option<NativeChild>,
    #[cfg(windows)]
    bound_at: Option<Instant>,
    #[cfg(windows)]
    first_terminal_at: Option<Instant>,
    #[cfg(windows)]
    process_signaled: bool,
    #[cfg(windows)]
    process_termination_attempted: bool,
    #[cfg(windows)]
    job_termination_attempted: bool,
    #[cfg(windows)]
    observed_exit_code: Option<i32>,
    #[cfg(windows)]
    promoted_evidence: Option<LauncherWireEvidenceV1>,
    #[cfg(windows)]
    promoted_worker_outcome: Option<(ReducerTerminal, String)>,
    promotion_diagnostic: WorkerPromotionDiagnostic,
    #[cfg(windows)]
    evidence_snapshot: Option<LauncherWireEvidenceV1>,
    #[cfg(windows)]
    drive_binding: HeldDriveBinding<OwnedNativeHandle>,
    // Declared last: fallback restoration runs after field-owned cleanup.
    #[cfg(windows)]
    quota_privilege: Option<native_launcher_privilege::ScopedQuotaPrivilege>,
}

impl Default for RealWin32Kernel {
    fn default() -> Self {
        Self {
            calls: Vec::new(),
            context: None,
            #[cfg(windows)]
            launcher_image: None,
            #[cfg(windows)]
            observer_image: None,
            #[cfg(windows)]
            surfaces: Vec::new(),
            #[cfg(windows)]
            observer_cwd: None,
            #[cfg(windows)]
            ledger: None,
            #[cfg(windows)]
            supervisor_ledger_evidence: None,
            #[cfg(windows)]
            outer_job: None,
            #[cfg(windows)]
            inner_job: None,
            #[cfg(windows)]
            source_token: None,
            #[cfg(windows)]
            restricted_token: None,
            #[cfg(windows)]
            package_sid: None,
            #[cfg(windows)]
            pipes: None,
            #[cfg(windows)]
            io: None,
            #[cfg(windows)]
            child: None,
            #[cfg(windows)]
            bound_at: None,
            #[cfg(windows)]
            first_terminal_at: None,
            #[cfg(windows)]
            process_signaled: false,
            #[cfg(windows)]
            process_termination_attempted: false,
            #[cfg(windows)]
            job_termination_attempted: false,
            #[cfg(windows)]
            observed_exit_code: None,
            #[cfg(windows)]
            promoted_evidence: None,
            #[cfg(windows)]
            promoted_worker_outcome: None,
            promotion_diagnostic: WorkerPromotionDiagnostic::default(),
            #[cfg(windows)]
            evidence_snapshot: None,
            #[cfg(windows)]
            drive_binding: HeldDriveBinding::default(),
            #[cfg(windows)]
            quota_privilege: None,
        }
    }
}

#[cfg(windows)]
impl Drop for RealWin32Kernel {
    fn drop(&mut self) {
        // Fallback only: finalization has already forbidden promotion on this
        // path. Close owned jobs first, then consume the anchor once; no
        // successful evidence depends on this best-effort shutdown.
        if self.drive_binding.handle.is_some() {
            drop(self.inner_job.take());
            drop(self.outer_job.take());
            drop(self.child.take());
            let _ = self.drive_binding.finish(&mut NativeDriveAnchorProvider);
        }
        if self.io.as_ref().is_some_and(|io| !io.retired) {
            if let Some(io) = self.io.take() {
                std::mem::forget(io);
            }
            if let Some(pipes) = self.pipes.take() {
                std::mem::forget(pipes);
            }
        }
    }
}

#[cfg(windows)]
impl RealWin32Kernel {
    fn build_evidence(
        &self,
        child: ChildStartEvidence,
    ) -> Result<LauncherWireEvidenceV1, &'static str> {
        if let Some(snapshot) = self.evidence_snapshot.as_ref() {
            return Ok(snapshot.clone());
        }
        let context = self.context.as_ref().ok_or("context not bound")?;
        if context.mode == Mode::Supervisor {
            return match child {
                ChildStartEvidence::NeverStarted => Ok(conservative_wire_evidence(child)),
                ChildStartEvidence::Started => self
                    .promoted_evidence
                    .clone()
                    .ok_or("supervisor has no validated worker evidence to promote"),
                ChildStartEvidence::Ambiguous => Ok(conservative_wire_evidence(child)),
            };
        }
        if child != ChildStartEvidence::Started {
            return Ok(conservative_wire_evidence(child));
        }
        let Some(io) = self.io.as_ref() else {
            return Ok(conservative_wire_evidence(child));
        };
        let stdout_state = if io.stdout_cap_exceeded {
            EvidenceStdoutState::CapExceededOrTruncated
        } else if io.stdout_eof {
            EvidenceStdoutState::Eof
        } else {
            EvidenceStdoutState::NotEofOrUnknown
        };
        let stderr_state = if io.stderr_nonzero_seen {
            EvidenceStderrState::NonzeroByteSeen
        } else if io.stderr_eof {
            EvidenceStderrState::EofZeroBytes
        } else {
            EvidenceStderrState::NotEofOrUnknown
        };
        let both_eof = stdout_state == EvidenceStdoutState::Eof
            && stderr_state == EvidenceStderrState::EofZeroBytes;
        let evidence = LauncherWireEvidenceV1 {
            kind: InvocationEvidenceKind::ChildStarted,
            invocation_attempt_count: 1,
            child_started: EvidenceChildStarted::Known(true),
            captured_stdout_base64: STANDARD
                .encode(&io.stdout_bytes[..io.stdout_bytes.len().min(MAX_STDOUT_BYTES)]),
            captured_stderr_base64: String::new(),
            stdout_state,
            stderr_state,
            stream_closure_state: if both_eof {
                EvidenceStreamClosureState::BothEof
            } else {
                EvidenceStreamClosureState::IncompleteOrUnknown
            },
            exit_state: self
                .observed_exit_code
                .map(|code| EvidenceExitState::Known { code })
                .unwrap_or(EvidenceExitState::Unknown),
        };
        validate_wire_evidence(&evidence)?;
        Ok(evidence)
    }

    fn deadline_timeout_ms(&self, include_drain_grace: bool) -> Result<u32, &'static str> {
        let context = self.context.as_ref().ok_or("context not bound")?;
        let started = self.bound_at.ok_or("monotonic start absent")?;
        let deadline_limit = context
            .envelope
            .deadline_ms
            .saturating_add(if include_drain_grace {
                DRAIN_GRACE_MS
            } else {
                0
            });
        let elapsed = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
        #[cfg(test)]
        let elapsed = native_budget_fixture_hook::elapsed(elapsed);
        let terminal_limit = if include_drain_grace {
            self.first_terminal_at.map(|terminal| {
                terminal
                    .duration_since(started)
                    .as_millis()
                    .min(u128::from(u64::MAX)) as u64
                    + DRAIN_GRACE_MS
            })
        } else {
            None
        };
        let limit = terminal_limit.map_or(deadline_limit, |value| value.min(deadline_limit));
        if elapsed >= limit {
            return Err("deadline reached");
        }
        Ok((limit - elapsed).min(u64::from(u32::MAX)) as u32)
    }

    fn begin_pipes(&mut self) -> Result<(), &'static str> {
        if self.pipes.is_some() || self.io.is_some() {
            return Err("pipe setup attempted twice");
        }
        let context = self.context.as_ref().ok_or("context not bound")?;
        self.pipes = Some(native_create_pipes(context)?);
        Ok(())
    }

    fn start_concurrent_io(&mut self) -> Result<(), &'static str> {
        if self.io.is_some() {
            return Err("concurrent I/O attempted twice");
        }
        let pipes = self.pipes.as_ref().ok_or("pipe handles absent")?;
        if pipes.child_stdin_read.is_some()
            || pipes.child_stdout_write.is_some()
            || pipes.child_stderr_write.is_some()
        {
            return Err("parent retained inherited child pipe ends");
        }
        let context = self.context.as_ref().ok_or("context not bound")?;
        let input = context.canonical_request_bytes.clone();
        let stdout_cap = if context.mode == Mode::Supervisor {
            MAX_WORKER_RESULT_BYTES
        } else {
            MAX_STDOUT_BYTES
        };
        let stdout = NativePendingIo::prepared(
            pipes.parent_stdout_read.raw(),
            NativeIoDirection::Read,
            vec![0u8; stdout_cap + 1],
        )?;
        let stderr = NativePendingIo::prepared(
            pipes.parent_stderr_read.raw(),
            NativeIoDirection::Read,
            vec![0u8; MAX_STDERR_BYTES + 1],
        )?;
        let stdin = NativePendingIo::prepared(
            pipes
                .parent_stdin_write
                .as_ref()
                .ok_or("stdin writer already closed")?
                .raw(),
            NativeIoDirection::Write,
            input,
        )?;
        self.io = Some(NativeIoBundle {
            stdin: Some(stdin),
            stdout: Some(stdout),
            stderr: Some(stderr),
            stdout_bytes: Vec::new(),
            stderr_bytes: Vec::new(),
            stdin_state: PipeState::Open,
            stdout_state: PipeState::Open,
            stderr_state: PipeState::Open,
            stdout_eof: false,
            stdout_cap_exceeded: false,
            stderr_eof: false,
            stderr_nonzero_seen: false,
            retired: false,
        });
        let io = self.io.as_mut().ok_or("I/O bundle disappeared")?;
        for operation in [&mut io.stdout, &mut io.stderr, &mut io.stdin]
            .into_iter()
            .flatten()
        {
            operation.submit()?;
        }
        Ok(())
    }

    fn transfer_stdin(&mut self) -> KernelReply {
        let timeout = match self.deadline_timeout_ms(false) {
            Ok(value) => value,
            Err(_) => return KernelReply::DeadlineReached,
        };
        let Some(io) = self.io.as_mut() else {
            return KernelReply::Unknown("I/O bundle absent");
        };
        let Some(operation) = io.stdin.as_mut() else {
            return KernelReply::Unknown("stdin operation absent or already consumed");
        };
        let Some(pipes) = self.pipes.as_mut() else {
            return KernelReply::Unknown("stdin writer owner absent");
        };
        let Some(writer) = pipes.parent_stdin_write.as_ref() else {
            return KernelReply::Unknown("stdin writer already consumed");
        };
        if operation.handle != writer.raw() {
            return KernelReply::Unknown("stdin operation and writer owner differ");
        }
        let expected = operation.buffer.len();
        match operation.finish(timeout) {
            Ok(bytes) if bytes as usize == expected => {
                // A completed write is not pipe EOF. Retire/drop the terminal
                // OVERLAPPED before closing its sole writer, so cancellation
                // cannot later act on a stale or reused raw handle.
                if operation.mark_retired().is_err() {
                    return KernelReply::Unknown("terminal stdin retirement failed");
                }
                drop(io.stdin.take());
                drop(pipes.parent_stdin_write.take());
                io.stdin_state = PipeState::Eof;
                KernelReply::TransferComplete { bytes: expected }
            }
            Ok(bytes) => {
                io.stdin_state = PipeState::Failed;
                KernelReply::BrokenPipe {
                    bytes: bytes as usize,
                    canonical_frame: false,
                }
            }
            Err(ERROR_BROKEN_PIPE) => {
                io.stdin_state = PipeState::Failed;
                KernelReply::BrokenPipe {
                    bytes: 0,
                    canonical_frame: false,
                }
            }
            Err(WAIT_TIMEOUT) => KernelReply::DeadlineReached,
            Err(_) => KernelReply::Unknown("stdin OVERLAPPED completion failed"),
        }
    }

    fn transfer_output(&mut self, stream: StreamKind) -> KernelReply {
        let context = match self.context.as_ref() {
            Some(value) => value.clone(),
            None => return KernelReply::Unknown("context not bound"),
        };
        let started = match self.bound_at {
            Some(value) => value,
            None => return KernelReply::Unknown("monotonic start absent"),
        };
        // Cleanup grace is reserved for termination/cancellation/reap, never
        // ordinary output service. Success already requires this deadline.
        let cutoff_ms = self
            .first_terminal_at
            .map_or(context.envelope.deadline_ms, |terminal| {
                let terminal_ms = terminal
                    .duration_since(started)
                    .as_millis()
                    .min(u128::from(u64::MAX)) as u64;
                context
                    .envelope
                    .deadline_ms
                    .min(terminal_ms.saturating_add(DRAIN_GRACE_MS))
            });
        let Some(io) = self.io.as_mut() else {
            return KernelReply::Unknown("I/O bundle absent");
        };
        let (slot, output, state, eof, violation, cap) = match stream {
            StreamKind::Stdout => (
                &mut io.stdout,
                &mut io.stdout_bytes,
                &mut io.stdout_state,
                &mut io.stdout_eof,
                &mut io.stdout_cap_exceeded,
                if context.mode == Mode::Supervisor {
                    MAX_WORKER_RESULT_BYTES
                } else {
                    MAX_STDOUT_BYTES
                },
            ),
            StreamKind::Stderr => (
                &mut io.stderr,
                &mut io.stderr_bytes,
                &mut io.stderr_state,
                &mut io.stderr_eof,
                &mut io.stderr_nonzero_seen,
                MAX_STDERR_BYTES,
            ),
            StreamKind::Stdin => return KernelReply::Unknown("stdin used as output"),
        };
        let Some(operation) = slot.as_mut() else {
            return KernelReply::Unknown("output operation absent or already consumed");
        };
        loop {
            let elapsed_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
            if elapsed_ms >= cutoff_ms {
                return KernelReply::DeadlineReached;
            }
            let timeout = (cutoff_ms - elapsed_ms).min(u64::from(u32::MAX)) as u32;
            match operation.finish(timeout) {
                Ok(0) | Err(ERROR_BROKEN_PIPE) => {
                    *state = PipeState::Eof;
                    *eof = true;
                    if self.first_terminal_at.is_none() {
                        self.first_terminal_at = Some(Instant::now());
                    }
                    let canonical_frame =
                        if stream == StreamKind::Stdout && context.mode == Mode::Supervisor {
                            match promote_worker_result_observed(
                                &context,
                                output,
                                &mut self.promotion_diagnostic,
                            ) {
                                Ok(parsed) => {
                                    let evidence = parsed.evidence.clone();
                                    self.promoted_worker_outcome =
                                        Some((parsed.terminal, parsed.reason));
                                    self.promoted_evidence = Some(evidence);
                                    true
                                }
                                Err(_) => false,
                            }
                        } else {
                            stream == StreamKind::Stderr || validate_observer_stdout_framing(output)
                        };
                    return KernelReply::Eof {
                        bytes: output.len(),
                        canonical_frame,
                    };
                }
                Ok(bytes) => {
                    let bytes = bytes as usize;
                    if bytes > operation.buffer.len() {
                        return KernelReply::Unknown("OVERLAPPED read byte count exceeded buffer");
                    }
                    output.extend_from_slice(&operation.buffer[..bytes]);
                    if output.len() > cap {
                        *state = PipeState::Failed;
                        *violation = true;
                        return KernelReply::Failed("output cap-plus-one sentinel observed");
                    }
                    let remaining = cap + 1 - output.len();
                    if operation
                        .prepare_next_read(remaining.min(8 * 1024))
                        .is_err()
                    {
                        return KernelReply::Unknown("follow-up OVERLAPPED read submit failed");
                    }
                }
                Err(WAIT_TIMEOUT) => return KernelReply::DeadlineReached,
                Err(_) => return KernelReply::Unknown("output OVERLAPPED completion failed"),
            }
        }
    }

    fn cancel_outstanding_io(&mut self) -> Result<(), &'static str> {
        let Some(io) = self.io.as_mut() else {
            return Ok(());
        };
        for operation in [&mut io.stdin, &mut io.stdout, &mut io.stderr]
            .into_iter()
            .flatten()
        {
            operation.cancel()?;
        }
        for state in [
            &mut io.stdin_state,
            &mut io.stdout_state,
            &mut io.stderr_state,
        ] {
            if *state == PipeState::Open {
                *state = PipeState::CancelPending;
            }
        }
        Ok(())
    }

    fn retire_io(&mut self) -> Result<(), &'static str> {
        if self.io.is_none() {
            return Err("I/O bundle absent for retirement");
        }
        for index in 0..3 {
            // One absolute cleanup deadline across all operations. Expiry
            // permits only a nonblocking completion readback, not a new grace.
            let timeout = self.deadline_timeout_ms(true).unwrap_or(0);
            let io = self.io.as_mut().ok_or("I/O bundle absent for retirement")?;
            let slot = match index {
                0 => &mut io.stdin,
                1 => &mut io.stdout,
                _ => &mut io.stderr,
            };
            if let Some(operation) = slot.as_mut() {
                if operation.state != NativeOperationState::Prepared {
                    match operation.finish(timeout) {
                        Err(232) if initial_write_no_data_retirement(operation.state) => {}
                        Ok(_) | Err(ERROR_OPERATION_ABORTED) | Err(ERROR_BROKEN_PIPE)
                            if operation.is_terminal() => {}
                        Err(_) => return Err("OVERLAPPED completion retirement failed"),
                        _ => return Err("OVERLAPPED retirement was not terminal"),
                    }
                }
                operation.mark_retired()?;
            }
        }
        let io = self.io.as_mut().ok_or("I/O bundle absent for retirement")?;
        for state in [
            &mut io.stdin_state,
            &mut io.stdout_state,
            &mut io.stderr_state,
        ] {
            if matches!(
                *state,
                PipeState::Open | PipeState::CancelPending | PipeState::Eof
            ) {
                *state = PipeState::Retired;
            }
        }
        io.retired = true;
        Ok(())
    }

    fn freeze_image(&mut self, kind: ImageKind) -> Result<(), &'static str> {
        let (slot, path) = match kind {
            ImageKind::Launcher => (&mut self.launcher_image, LAUNCHER_IMAGE),
            ImageKind::Observer => (&mut self.observer_image, OBSERVER_IMAGE),
        };
        if slot.is_some() {
            return Err("image freeze attempted twice");
        }
        *slot = Some(open_native_file(
            path,
            false,
            false,
            TypedHandleKind::HeldImage,
        )?);
        Ok(())
    }

    fn verify_image(&self, kind: ImageKind) -> Result<(), &'static str> {
        let (held, path) = match kind {
            ImageKind::Launcher => (self.launcher_image.as_ref(), LAUNCHER_IMAGE),
            ImageKind::Observer => (self.observer_image.as_ref(), OBSERVER_IMAGE),
        };
        let held = held.ok_or("image was not frozen")?;
        let current =
            native_file_snapshot(held.handle.raw(), path, false, false, held.handle.kind())?;
        if !current.stable_integrity_matches(&held.snapshot) {
            return Err("held image identity, ACL, timestamps, or raw hash drifted");
        }
        Ok(())
    }

    fn freeze_surfaces(&mut self) -> Result<(), &'static str> {
        if !self.surfaces.is_empty() || self.observer_cwd.is_some() {
            return Err("surface freeze attempted twice");
        }
        self.surfaces
            .push(open_native_surface(LAUNCHER_LEDGER_ROOT, false)?);
        self.surfaces
            .push(open_native_surface(ACCEPTED_EVIDENCE_ROOT, true)?);
        let handle = OwnedNativeHandle::new(unsafe { CreateFileW(wide(FIXED_OBSERVER_CWD).as_ptr(),
            FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_SHARE_READ, null(), OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) },
            TypedHandleKind::HeldAncestor).map_err(|_| "observer CWD held open failed")?;
        let snapshot = observer_cwd_snapshot(handle.raw(), FIXED_OBSERVER_CWD)?;
        self.observer_cwd = Some(HeldObserverCwd { handle, snapshot });
        Ok(())
    }

    fn verify_surfaces(&self) -> Result<(), &'static str> {
        let cwd = self.observer_cwd.as_ref().ok_or("observer CWD was not held")?;
        if observer_cwd_snapshot(cwd.handle.raw(), FIXED_OBSERVER_CWD)? != cwd.snapshot {
            return Err("held observer CWD security or identity drifted");
        }
        if self.surfaces.len() != 2 {
            return Err("exact two security surfaces were not held");
        }
        for (index, held) in self.surfaces.iter().enumerate() {
            let expected = if index == 0 {
                LAUNCHER_LEDGER_ROOT
            } else {
                ACCEPTED_EVIDENCE_ROOT
            };
            let current = native_surface_snapshot(held.handle.raw(), expected, index == 1)?;
            if current != held.snapshot {
                return Err("security surface owner/DACL/MIC/final-path drifted");
            }
        }
        Ok(())
    }

    fn verify_supervisor_ledger_proof(&mut self) -> Result<(), &'static str> {
        if self.supervisor_ledger_evidence.is_some() {
            return Err("supervisor ledger proof verification attempted twice");
        }
        let context = self.context.as_ref().ok_or("context not bound")?;
        if context.mode != Mode::Worker {
            return Err("supervisor ledger proof is only valid in worker mode");
        }
        let proof = context
            .supervisor_ledger_proof
            .as_ref()
            .ok_or("supervisor ledger proof absent")?;
        if proof != &context.supervisor_proof() {
            return Err("supervisor ledger proof fields drifted");
        }
        let path = format!(
            "{}\\{}.json",
            LAUNCHER_LEDGER_ROOT, proof.supervisor_ledger_identity_sha256
        );
        let held = open_native_file(&path, true, false, TypedHandleKind::Ledger)?;
        let expected = context.ledger_record_bytes(LedgerStage::SupervisorBeforeWorker);
        if held.snapshot.sha256 != proof.supervisor_ledger_record_sha256 {
            return Err("supervisor ledger proof raw hash mismatch");
        }
        native_read_exact(held.handle.raw(), &expected)?;
        self.supervisor_ledger_evidence = Some(held);
        Ok(())
    }

    fn reverify_supervisor_ledger_evidence(&self) -> Result<(), &'static str> {
        let Some(held) = self.supervisor_ledger_evidence.as_ref() else {
            return Ok(());
        };
        let context = self.context.as_ref().ok_or("context not bound")?;
        let proof = context
            .supervisor_ledger_proof
            .as_ref()
            .ok_or("supervisor ledger proof absent")?;
        let path = format!(
            "{}\\{}.json",
            LAUNCHER_LEDGER_ROOT, proof.supervisor_ledger_identity_sha256
        );
        let current = native_file_snapshot(
            held.handle.raw(),
            &path,
            true,
            false,
            TypedHandleKind::Ledger,
        )?;
        if !current.stable_integrity_matches(&held.snapshot) {
            return Err("held supervisor ledger identity/ACL/hash drifted");
        }
        native_read_exact(
            held.handle.raw(),
            &context.ledger_record_bytes(LedgerStage::SupervisorBeforeWorker),
        )
    }

    fn flush_ledger(&mut self) -> Result<(), &'static str> {
        let ledger = self.ledger.as_mut().ok_or("ledger not created")?;
        let handle = ledger.handle.as_ref().ok_or("ledger handle absent")?;
        if unsafe { FlushFileBuffers(handle.raw()) } == 0 {
            return Err("FlushFileBuffers ledger failed");
        }
        native_read_exact(handle.raw(), &ledger.record_bytes)?;
        let snapshot = native_file_snapshot(
            handle.raw(),
            &ledger.path,
            true,
            false,
            TypedHandleKind::Ledger,
        )?;
        let expected_hash = sha256_hex(&ledger.record_bytes);
        if snapshot.sha256 != expected_hash {
            return Err("ledger same-handle raw hash mismatch");
        }
        ledger.frozen = Some(snapshot);
        Ok(())
    }

    fn reopen_ledger(&mut self) -> Result<(), &'static str> {
        let ledger = self.ledger.as_mut().ok_or("ledger not created")?;
        let frozen = ledger
            .frozen
            .as_ref()
            .ok_or("ledger was not flushed")?
            .clone();
        drop(ledger.handle.take());
        use std::os::windows::io::IntoRawHandle;
        let expected_security = native_ledger_security::LedgerSecuritySnapshot {
            owner_sid: frozen.security.owner_sid.clone(),
            dacl_ace_count: frozen.security.dacl_ace_count,
            low_integrity_no_write_up: frozen.security.low_integrity_no_write_up,
            descriptor_bytes: frozen
                .security
                .ledger_descriptor_bytes
                .clone()
                .ok_or("ledger security bytes absent")?,
        };
        let file = native_ledger_security::reopen_ledger(&ledger.path, &expected_security)?;
        let handle = OwnedNativeHandle::new(file.into_raw_handle(), TypedHandleKind::Ledger)
            .map_err(|_| "ledger reopened handle transfer failed")?;
        let snapshot = native_file_snapshot(
            handle.raw(),
            &ledger.path,
            true,
            false,
            TypedHandleKind::Ledger,
        )?;
        let reopened = HeldNativeFile { handle, snapshot };
        if !reopened.snapshot.stable_integrity_matches(&frozen) {
            return Err("ledger reopen identity/ACL/hash mismatch");
        }
        native_read_exact(reopened.handle.raw(), &ledger.record_bytes)?;
        ledger.handle = Some(reopened.handle);
        Ok(())
    }

    fn ensure_source_token(&mut self) -> Result<(), &'static str> {
        if self.source_token.is_none() {
            self.source_token = Some(native_open_process_token(unsafe { GetCurrentProcess() })?);
        }
        Ok(())
    }

    fn create_restricted_token(&mut self) -> Result<(), &'static str> {
        self.ensure_source_token()?;
        if self.restricted_token.is_some() {
            return Err("restricted token creation attempted twice");
        }
        self.restricted_token = Some(native_create_restricted_primary(
            self.source_token.as_ref().expect("source token set").raw(),
        )?);
        Ok(())
    }

    fn verify_zero_token_capabilities(&self) -> Result<(), &'static str> {
        let token = self
            .restricted_token
            .as_ref()
            .ok_or("restricted token absent")?;
        let capabilities = native_token_information(token.raw(), TokenCapabilities)?;
        let capabilities = unsafe { &*(capabilities.as_ptr().cast::<TOKEN_GROUPS>()) };
        if capabilities.GroupCount != 0 || self.package_sid.is_none() {
            return Err("token capabilities are nonzero or package SID absent");
        }
        Ok(())
    }

    fn create_child(&mut self, kind: ChildKind) -> Result<(), NativeCreateError> {
        if self.child.is_some() {
            return Err("child creation attempted twice".into());
        }
        self.ensure_source_token()?;
        if kind == ChildKind::Observer {
            self.drive_binding.acquire(&mut NativeDriveAnchorProvider,
                self.context.as_ref().ok_or("drive binding context absent")?)?;
        }
        let token = match kind {
            ChildKind::Worker => self.source_token.as_ref().expect("source token set").raw(),
            ChildKind::Observer => self
                .restricted_token
                .as_ref()
                .ok_or("observer restricted token absent")?
                .raw(),
        };
        let pipes = self
            .pipes
            .as_mut()
            .ok_or("pipe handles absent before child create")?;
        let binding = if kind == ChildKind::Observer {
            Some(self.drive_binding.generated(self.context.as_ref().ok_or("drive binding context absent")?)?)
        } else { None };
        let child = native_create_child(kind, token, pipes, self.package_sid.as_ref(), binding)?;
        pipes.close_child_ends();
        self.child = Some(child);
        Ok(())
    }

    fn assign_child(&mut self, inner: bool) -> Result<(), &'static str> {
        let child = self
            .child
            .as_mut()
            .ok_or("child absent for job assignment")?;
        if child.assigned {
            return Err("child assignment attempted twice");
        }
        let job = if inner {
            self.inner_job.as_ref().ok_or("inner job absent")?
        } else {
            self.outer_job.as_ref().ok_or("outer job absent")?
        };
        if unsafe { AssignProcessToJobObject(job.handle.raw(), child.process.raw()) } == 0 {
            return Err("AssignProcessToJobObject failed");
        }
        child.assigned = true;
        child.containment = if inner {
            ContainmentState::InnerAssignedPendingVerify
        } else {
            ContainmentState::OuterAssignedPendingVerify
        };
        Ok(())
    }

    fn verify_outer_membership(&mut self) -> Result<(), &'static str> {
        let child = self.child.as_mut().ok_or("child absent")?;
        if let Some(outer) = self.outer_job.as_ref() {
            native_verify_job_membership(child.process.raw(), outer.handle.raw())?;
            child.containment = ContainmentState::OuterAssignedVerified;
            Ok(())
        } else {
            let mut contained = 0;
            if unsafe { IsProcessInJob(child.process.raw(), null_mut(), &mut contained) } == 0
                || contained == 0
            {
                return Err("child did not inherit outer containment");
            }
            Ok(())
        }
    }

    fn verify_observer_confinement(&mut self) -> Result<(), &'static str> {
        let child = self.child.as_mut().ok_or("observer child absent")?;
        if child.kind != ChildKind::Observer || !child.assigned {
            return Err("observer child kind/assignment state invalid");
        }
        native_verify_job_membership(
            child.process.raw(),
            self.inner_job
                .as_ref()
                .ok_or("inner job absent")?
                .handle
                .raw(),
        )?;
        child.containment = ContainmentState::InnerAssignedVerified;
        let mut outer = 0;
        if unsafe { IsProcessInJob(child.process.raw(), null_mut(), &mut outer) } == 0 || outer == 0
        {
            return Err("observer is not outer-contained");
        }
        native_verify_process_appcontainer(
            child.process.raw(),
            self.package_sid.as_ref().ok_or("package SID absent")?.0,
        )?;
        let mut token = null_mut();
        if unsafe { OpenProcessToken(child.process.raw(), TOKEN_QUERY, &mut token) } == 0 {
            return Err("observer actual child token readback acquisition failed");
        }
        let token = OwnedNativeHandle::new(token, TypedHandleKind::Token)
            .map_err(|_| "observer actual child token readback handle invalid")?;
        native_verify_restricted_primary(
            self.source_token.as_ref().ok_or("observer source token absent")?.raw(), token.raw())?;
        native_verify_child_image(
            child,
            self.observer_image
                .as_ref()
                .ok_or("held observer image absent")?,
        )
    }
}

impl LauncherKernel for RealWin32Kernel {
    fn finalize_invocation(&mut self) -> Result<(), &'static str> {
        #[cfg(windows)]
        {
            if self.drive_binding.handle.is_some() && self.child.as_ref().is_some_and(|child|
                unsafe { WaitForSingleObject(child.process.raw(), 0) } != WAIT_OBJECT_0)
            {
                self.drive_binding.failed = true;
                self.evidence_snapshot = None;
                return Err(DRIVE_BINDING_FAILURE);
            }
            if self.drive_binding.finish(&mut NativeDriveAnchorProvider).is_err() {
                self.evidence_snapshot = None;
                return Err(DRIVE_BINDING_FAILURE);
            }
        }
        Ok(())
    }
    #[cfg(windows)]
    fn io_stop_observation(&self) -> (Option<IoNativeDiagnostic>, Option<u32>) {
        let io = self.io.as_ref().and_then(|bundle| {
            [(IoDiagnosticStream::Stdin, &bundle.stdin),
                (IoDiagnosticStream::Stdout, &bundle.stdout),
                (IoDiagnosticStream::Stderr, &bundle.stderr)]
                .into_iter().find_map(|(stream, slot)| {
                    let op = slot.as_ref()?;
                    let (api, code) = op.failure?;
                    let direction = match op.direction {
                        NativeIoDirection::Read => IoDiagnosticDirection::Read,
                        NativeIoDirection::Write => IoDiagnosticDirection::Write,
                    };
                    let state = match op.state {
                        NativeOperationState::Prepared => IoDiagnosticState::Prepared,
                        NativeOperationState::Pending => IoDiagnosticState::Pending,
                        NativeOperationState::Immediate(_) => IoDiagnosticState::Immediate,
                        NativeOperationState::Terminal(_) => IoDiagnosticState::Terminal,
                        NativeOperationState::TerminalError(_) => IoDiagnosticState::TerminalError,
                        NativeOperationState::InitialWriteNoData => IoDiagnosticState::InitialWriteNoData,
                        NativeOperationState::CancelRequested => IoDiagnosticState::CancelRequested,
                        NativeOperationState::Retired => IoDiagnosticState::Retired,
                    };
                    Some(IoNativeDiagnostic { stream, direction, api, state, code })
                })
        });
        // Diagnostic only: the retained process must actually be signaled.
        // Preserve the raw DWORD, including 259/high-bit codes, without changing
        // PollProcess, signed wire evidence, deadline or acceptance semantics.
        let exit = self.child.as_ref().and_then(|child| {
            if unsafe { WaitForSingleObject(child.process.raw(), 0) } != WAIT_OBJECT_0 { return None; }
            let mut code = 0;
            if unsafe { GetExitCodeProcess(child.process.raw(), &mut code) } == 0 { None } else { Some(code) }
        });
        (io, exit)
    }

    fn bind_context(&mut self, context: &ProductionInvocationContext) -> KernelReply {
        if self.context.is_some() {
            return KernelReply::Refused("production context cannot be rebound");
        }
        self.context = Some(context.clone());
        #[cfg(windows)]
        {
            self.bound_at = Some(Instant::now());
            // Both launcher supervisor and worker acquire only their own token.
            // This precedes ledger creation and every native effect capability.
            self.quota_privilege = match native_launcher_privilege::ScopedQuotaPrivilege::acquire()
            {
                Ok(scope) => Some(scope),
                Err(native_launcher_privilege::AcquireError::Refused(_)) => {
                    return KernelReply::Refused(
                        "launcher-local quota privilege acquisition failed",
                    );
                }
                Err(native_launcher_privilege::AcquireError::RestorationUnknown(_)) => {
                    return KernelReply::Unknown(
                        "launcher quota acquisition restoration is unverified",
                    );
                }
            };
        }
        KernelReply::Ok
    }

    fn invoke(&mut self, step: Step) -> KernelReply {
        self.calls.push(step);
        #[cfg(not(windows))]
        return match step {
            Step::ValidateFixedBinding
                if LAUNCHER_IMAGE.starts_with(r"\\?\C:\")
                    && OBSERVER_IMAGE.starts_with(r"\\?\C:\")
                    && FIXED_CWD.starts_with(r"\\?\C:\")
                    && EXACT_ENVIRONMENT_KEYS == ["SystemDrive", "SystemRoot", "WINDIR"] =>
            {
                KernelReply::Ok
            }
            _ => KernelReply::Refused("Windows native launcher is unavailable on this platform"),
        };

        #[cfg(windows)]
        match step {
            Step::ValidateFixedBinding => {
                let Some(context) = self.context.as_ref() else {
                    return KernelReply::Refused("production context is absent");
                };
                let canonical = serde_json::to_vec(&context.envelope).unwrap_or_default();
                if canonical != context.canonical_header_bytes
                    || context.ledger_identity_sha256.len() != 64
                    || context.observer_payload_sha256 != context.envelope.stdin_sha256
                    || context.observer_payload_bytes.len() as u64
                        != context.envelope.stdin_byte_count
                    || !LAUNCHER_IMAGE.starts_with(r"\\?\C:\")
                    || !OBSERVER_IMAGE.starts_with(r"\\?\C:\")
                    || !FIXED_CWD.starts_with(r"\\?\C:\")
                    || EXACT_ENVIRONMENT_KEYS != ["SystemDrive", "SystemRoot", "WINDIR"]
                {
                    KernelReply::Refused("immutable production binding drifted")
                } else if let Err(reason) = native_verify_program_data_binding()
                    .and_then(|_| fixed_environment_block().map(|_| ()))
                {
                    KernelReply::Refused(reason)
                } else {
                    KernelReply::Ok
                }
            }
            Step::FreezeImage(kind) => self
                .freeze_image(kind)
                .map(|_| KernelReply::Ok)
                .unwrap_or_else(KernelReply::Failed),
            Step::VerifyImage(kind) => {
                let verified = self.verify_image(kind);
                if verified.is_ok() {
                    let context = self.context.as_ref().expect("context bound");
                    let (held, expected) = match kind {
                        ImageKind::Launcher => (
                            self.launcher_image.as_ref(),
                            &context.envelope.launcher_image_sha256,
                        ),
                        ImageKind::Observer => (
                            self.observer_image.as_ref(),
                            &context.envelope.observer_image_sha256,
                        ),
                    };
                    if held.is_none_or(|value| value.snapshot.sha256 != *expected) {
                        return KernelReply::Failed("image hash mismatched request binding");
                    }
                }
                let process_verified = if verified.is_ok() {
                    match (kind, self.child.as_ref()) {
                        (ImageKind::Launcher, Some(child)) if child.kind == ChildKind::Worker => {
                            native_verify_child_image(
                                child,
                                self.launcher_image.as_ref().expect("held launcher image"),
                            )
                        }
                        (ImageKind::Observer, Some(child)) if child.kind == ChildKind::Observer => {
                            native_verify_child_image(
                                child,
                                self.observer_image.as_ref().expect("held observer image"),
                            )
                        }
                        _ => Ok(()),
                    }
                } else {
                    Ok(())
                };
                verified
                    .and(process_verified)
                    .map(|_| KernelReply::Ok)
                    .unwrap_or_else(KernelReply::Failed)
            }
            Step::FreezeSurface => self
                .freeze_surfaces()
                .map(|_| KernelReply::Ok)
                .unwrap_or_else(KernelReply::Failed),
            Step::VerifySurface => self
                .verify_surfaces()
                .map(|_| KernelReply::Ok)
                .unwrap_or_else(KernelReply::Failed),
            Step::VerifySupervisorLedgerProof => self
                .verify_supervisor_ledger_proof()
                .map(|_| KernelReply::Ok)
                .unwrap_or_else(KernelReply::Refused),
            Step::CreateDurableLedger => {
                let Some(context) = self.context.as_ref() else {
                    return KernelReply::Unknown("ledger context absent");
                };
                if self.ledger.is_some() {
                    return KernelReply::LedgerCollision;
                }
                match native_create_ledger(context) {
                    Ok(ledger) => {
                        self.ledger = Some(ledger);
                        KernelReply::Ok
                    }
                    Err(reply) => reply,
                }
            }
            Step::FlushLedgerReadback => self
                .flush_ledger()
                .map(|_| KernelReply::Ok)
                .unwrap_or_else(KernelReply::Unknown),
            Step::ReopenLedgerVerify | Step::ReopenDurableEvidence => self
                .reopen_ledger()
                .map(|_| KernelReply::Ok)
                .unwrap_or_else(KernelReply::Unknown),
            Step::CreateOuterJob(limits) => {
                if self.outer_job.is_some() || limits != OUTER_JOB_LIMITS {
                    KernelReply::Failed("outer job duplicate or limit drift")
                } else {
                    match native_create_job(limits, TypedHandleKind::OuterJob) {
                        Ok(job) => {
                            self.outer_job = Some(job);
                            KernelReply::Ok
                        }
                        Err(reason) => KernelReply::Failed(reason),
                    }
                }
            }
            Step::VerifyOuterJob(limits) => self
                .outer_job
                .as_ref()
                .filter(|job| job.limits == limits)
                .ok_or("outer job absent or requested limits drifted")
                .and_then(native_verify_job)
                .map(|_| KernelReply::Ok)
                .unwrap_or_else(KernelReply::Failed),
            Step::VerifyAlreadyOuterContained => {
                let mut contained = 0;
                if unsafe { IsProcessInJob(GetCurrentProcess(), null_mut(), &mut contained) } == 0
                    || contained == 0
                {
                    KernelReply::Refused("worker is not already outer-job-contained")
                } else {
                    KernelReply::Ok
                }
            }
            Step::CreateInnerJob(limits) => {
                if self.inner_job.is_some() || limits != INNER_JOB_LIMITS {
                    KernelReply::Failed("inner job duplicate or limit drift")
                } else {
                    match native_create_job(limits, TypedHandleKind::InnerJob) {
                        Ok(job) => {
                            self.inner_job = Some(job);
                            KernelReply::Ok
                        }
                        Err(reason) => KernelReply::Failed(reason),
                    }
                }
            }
            Step::VerifyInnerJob(limits) => self
                .inner_job
                .as_ref()
                .filter(|job| job.limits == limits)
                .ok_or("inner job absent or requested limits drifted")
                .and_then(native_verify_job)
                .map(|_| KernelReply::Ok)
                .unwrap_or_else(KernelReply::Failed),
            Step::GateSeIncreaseQuota => self
                .ensure_source_token()
                .and_then(|_| {
                    self.quota_privilege
                        .as_ref()
                        .ok_or("launcher-local quota privilege scope absent")?
                        .verify_enabled()
                        .map_err(|_| "launcher-local quota readback failed")
                })
                .and_then(|_| {
                    native_gate_increase_quota(
                        self.source_token.as_ref().expect("source token set").raw(),
                    )
                })
                .map(|_| KernelReply::Ok)
                .unwrap_or_else(KernelReply::Refused),
            Step::CreateRestrictedPrimaryToken { rights, policy } => {
                if rights != TOKEN_RIGHTS || policy != RESTRICTED_TOKEN_POLICY {
                    KernelReply::Refused("restricted primary token call policy drifted")
                } else {
                    self.create_restricted_token()
                        .map(|_| KernelReply::Ok)
                        .unwrap_or_else(KernelReply::Failed)
                }
            }
            Step::SetLowIntegrity => self
                .restricted_token
                .as_ref()
                .ok_or("restricted token absent")
                .and_then(|token| native_set_low_integrity(token.raw()))
                .and_then(|_| {
                    native_verify_restricted_primary(
                        self.source_token.as_ref().ok_or("source token absent")?.raw(),
                        self.restricted_token.as_ref().expect("token set").raw(),
                    )
                })
                .map(|_| KernelReply::Ok)
                .unwrap_or_else(KernelReply::Failed),
            Step::DeriveRegularAppContainerSid => {
                if self.package_sid.is_some() {
                    KernelReply::Failed("package SID derivation attempted twice")
                } else {
                    match derive_fixed_package_sid() {
                        Ok(sid) => {
                            self.package_sid = Some(sid);
                            KernelReply::Ok
                        }
                        Err(reason) => KernelReply::Failed(reason),
                    }
                }
            }
            Step::VerifyAppContainerZeroCapabilities => self
                .verify_zero_token_capabilities()
                .map(|_| KernelReply::Ok)
                .unwrap_or_else(KernelReply::Failed),
            Step::VerifyLoopbackNonExempt => self
                .package_sid
                .as_ref()
                .ok_or("package SID absent")
                .and_then(|sid| native_verify_loopback_nonexempt(sid.0))
                .map(|_| KernelReply::Ok)
                .unwrap_or_else(KernelReply::Failed),
            Step::CreateSuspendedChild(kind) => native_create_reply(self.create_child(kind)),
            Step::AssignOuterJob => self
                .assign_child(false)
                .map(|_| KernelReply::Ok)
                .unwrap_or_else(KernelReply::Failed),
            Step::AssignInnerJob => self
                .assign_child(true)
                .map(|_| KernelReply::Ok)
                .unwrap_or_else(KernelReply::Failed),
            Step::VerifyOuterMembership => self
                .verify_outer_membership()
                .map(|_| KernelReply::Ok)
                .unwrap_or_else(KernelReply::Failed),
            Step::VerifyObserverConfinement => self
                .verify_observer_confinement()
                .map(|_| KernelReply::Ok)
                .unwrap_or_else(KernelReply::Failed),
            Step::ResumePrimaryThread => {
                if self.child.as_ref().is_some_and(|child| child.kind == ChildKind::Observer)
                    && self.drive_binding.revalidate(&mut NativeDriveAnchorProvider).is_err()
                { return KernelReply::Unknown("observer drive binding before resume failed"); }
                let Some(child) = self.child.as_mut() else {
                    return KernelReply::Unknown("child absent for resume");
                };
                if child.resumed
                    || !matches!(
                        child.containment,
                        ContainmentState::OuterAssignedVerified
                            | ContainmentState::InnerAssignedVerified
                    )
                {
                    return KernelReply::Unknown("primary thread resume attempted twice");
                }
                let previous = unsafe { ResumeThread(child.thread.raw()) };
                if previous == u32::MAX {
                    KernelReply::Unknown("ResumeThread failed")
                } else {
                    child.resumed = true;
                    child.containment = ContainmentState::ResumedExactlyOnce;
                    KernelReply::ResumeCount(previous)
                }
            }
            Step::SampleThreadCount => self
                .child
                .as_ref()
                .ok_or("child absent for thread sample")
                .and_then(|child| native_thread_count(child.process_id))
                .map(KernelReply::ThreadCount)
                .unwrap_or_else(KernelReply::Failed),
            Step::BeginPinnedOverlappedPipes => self
                .begin_pipes()
                .map(|_| KernelReply::Ok)
                .unwrap_or_else(KernelReply::Failed),
            Step::StartConcurrentIo => self
                .start_concurrent_io()
                .map(|_| KernelReply::Ok)
                .unwrap_or_else(KernelReply::Failed),
            Step::Transfer(StreamKind::Stdin) => self.transfer_stdin(),
            Step::Transfer(StreamKind::Stdout) => self.transfer_output(StreamKind::Stdout),
            Step::Transfer(StreamKind::Stderr) => self.transfer_output(StreamKind::Stderr),
            Step::PollProcess => {
                let timeout = match self.deadline_timeout_ms(false) {
                    Ok(value) => value,
                    Err(_) => return KernelReply::DeadlineReached,
                };
                let Some(child) = self.child.as_ref() else {
                    return KernelReply::Unknown("child absent for process poll");
                };
                match native_budgeted_wait(child.process.raw(), timeout) {
                    WAIT_OBJECT_0 => {
                        self.process_signaled = true;
                        if self.first_terminal_at.is_none() {
                            self.first_terminal_at = Some(Instant::now());
                        }
                        let mut exit_code = STILL_ACTIVE as u32;
                        if unsafe { GetExitCodeProcess(child.process.raw(), &mut exit_code) } == 0 {
                            KernelReply::Unknown("GetExitCodeProcess failed")
                        } else if exit_code == STILL_ACTIVE as u32 {
                            KernelReply::StillActive
                        } else {
                            self.observed_exit_code = i32::try_from(exit_code).ok();
                            KernelReply::ExitCode(exit_code)
                        }
                    }
                    WAIT_TIMEOUT => KernelReply::DeadlineReached,
                    _ => KernelReply::Unknown("process wait poll failed"),
                }
            }
            Step::VerifySignaledProcess => {
                let Some(child) = self.child.as_ref() else {
                    return KernelReply::Unknown("child absent for signal verification");
                };
                if self.process_signaled
                    && unsafe { WaitForSingleObject(child.process.raw(), 0) } == WAIT_OBJECT_0
                {
                    KernelReply::MatchingProcess
                } else {
                    KernelReply::Unknown("launched process is not the signaled process")
                }
            }
            Step::RecheckDeadline => {
                if self.deadline_timeout_ms(false).is_ok() {
                    KernelReply::DeadlineNotReached
                } else {
                    if self.first_terminal_at.is_none() {
                        self.first_terminal_at = Some(Instant::now());
                    }
                    KernelReply::DeadlineReached
                }
            }
            Step::CancelOutstandingIo => self
                .cancel_outstanding_io()
                .map(|_| KernelReply::Ok)
                .unwrap_or_else(KernelReply::Unknown),
            Step::RetireIoCompletion => self
                .retire_io()
                .map(|_| KernelReply::Ok)
                .unwrap_or_else(KernelReply::Unknown),
            Step::TerminateProcessOnce => {
                if self.process_termination_attempted {
                    return KernelReply::Unknown("TerminateProcess attempted twice");
                }
                self.process_termination_attempted = true;
                self.first_terminal_at.get_or_insert_with(Instant::now);
                let Some(child) = self.child.as_ref() else {
                    return KernelReply::Unknown("child handle absent for termination");
                };
                if unsafe { TerminateProcess(child.process.raw(), 0xE003_2001) } == 0 {
                    KernelReply::Unknown("TerminateProcess failed")
                } else {
                    KernelReply::Ok
                }
            }
            Step::TerminateJobOnce => {
                if self.job_termination_attempted {
                    return KernelReply::Unknown("TerminateJobObject attempted twice");
                }
                self.job_termination_attempted = true;
                self.first_terminal_at.get_or_insert_with(Instant::now);
                let job = if self.inner_job.is_some() {
                    self.inner_job.as_ref()
                } else {
                    self.outer_job.as_ref()
                };
                let Some(job) = job else {
                    return KernelReply::Unknown("assigned job handle absent for termination");
                };
                if unsafe { TerminateJobObject(job.handle.raw(), 0xE003_2002) } == 0 {
                    KernelReply::Unknown("TerminateJobObject failed")
                } else {
                    KernelReply::Ok
                }
            }
            Step::WaitForStableReap => {
                let Some(child) = self.child.as_ref() else {
                    return KernelReply::Unknown("child absent for reap");
                };
                let timeout = self.deadline_timeout_ms(true).unwrap_or(0);
                match native_budgeted_wait(child.process.raw(), timeout) {
                    WAIT_OBJECT_0 => {
                        let mut code = STILL_ACTIVE as u32;
                        if unsafe { GetExitCodeProcess(child.process.raw(), &mut code) } != 0
                            && code != STILL_ACTIVE as u32
                        {
                            self.observed_exit_code = i32::try_from(code).ok();
                        }
                        KernelReply::Ok
                    }
                    WAIT_TIMEOUT => KernelReply::Unknown("bounded process reap timed out"),
                    _ => KernelReply::Unknown("WaitForSingleObject reap failed"),
                }
            }
            Step::FinalIdentityAclHashReverify => self
                .verify_image(ImageKind::Launcher)
                .and_then(|_| self.verify_image(ImageKind::Observer))
                .and_then(|_| self.verify_surfaces())
                .and_then(|_| self.reverify_supervisor_ledger_evidence())
                .and_then(|_| {
                    if self.context.as_ref().is_some_and(|context| context.mode == Mode::Worker) {
                        self.drive_binding.revalidate(&mut NativeDriveAnchorProvider)
                    } else { Ok(()) }
                })
                .map(|_| KernelReply::Ok)
                .unwrap_or_else(KernelReply::Failed),
            Step::ReleaseHeldImageHandles => {
                if self.drive_binding.finish(&mut NativeDriveAnchorProvider).is_err() {
                    self.evidence_snapshot = None;
                    return KernelReply::Unknown(DRIVE_BINDING_FAILURE);
                }
                let evidence = match self.build_evidence(ChildStartEvidence::Started) {
                    Ok(evidence) => evidence,
                    Err(reason) => return KernelReply::Unknown(reason),
                };
                self.evidence_snapshot = Some(evidence);
                drop(self.launcher_image.take());
                drop(self.observer_image.take());
                self.surfaces.clear();
                self.observer_cwd.take();
                if let Some(ledger) = self.ledger.as_mut() {
                    drop(ledger.handle.take());
                }
                drop(self.supervisor_ledger_evidence.take());
                drop(self.io.take());
                drop(self.pipes.take());
                drop(self.child.take());
                drop(self.restricted_token.take());
                drop(self.source_token.take());
                drop(self.package_sid.take());
                drop(self.inner_job.take());
                drop(self.outer_job.take());
                // No successful result may depend on Drop's best-effort restore.
                if self
                    .quota_privilege
                    .as_mut()
                    .ok_or("launcher-local quota privilege scope absent")
                    .and_then(|scope| {
                        scope
                            .restore_verified()
                            .map_err(|_| "launcher quota restore readback failed")
                    })
                    .is_err()
                {
                    return KernelReply::Unknown("launcher quota restoration was not verified");
                }
                KernelReply::Ok
            }
        }
    }

    #[cfg(windows)]
    fn promoted_worker_outcome(&self) -> Option<(ReducerTerminal, String)> {
        self.promoted_worker_outcome.clone()
    }

    fn worker_promotion_diagnostic(&self) -> WorkerPromotionDiagnostic {
        self.promotion_diagnostic
    }

    fn snapshot_evidence(
        &mut self,
        context: &ProductionInvocationContext,
        child: ChildStartEvidence,
    ) -> Result<LauncherWireEvidenceV1, &'static str> {
        #[cfg(not(windows))]
        {
            let _ = context;
            return Ok(conservative_wire_evidence(child));
        }
        #[cfg(windows)]
        {
            if self.context.as_ref() != Some(context) {
                return Err("evidence snapshot context differs");
            }
            self.build_evidence(child)
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReducerTerminal {
    Success,
    Refused,
    Failed,
    Unknown,
    Deadline,
    Quarantined,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReducerResult {
    pub terminal: ReducerTerminal,
    pub reason: Cow<'static, str>,
    pub invocation_attempt_count: u8,
    pub child_start_evidence: ChildStartEvidence,
    pub child_started: &'static str,
    pub ledger_state: &'static str,
    pub sticky: bool,
    pub handles_released: bool,
}

fn stopped(
    terminal: ReducerTerminal,
    reason: impl Into<Cow<'static, str>>,
    child: ChildStartEvidence,
    ledger: LedgerState,
    sticky: bool,
) -> ReducerResult {
    ReducerResult {
        terminal,
        reason: reason.into(),
        invocation_attempt_count: 1,
        child_start_evidence: child,
        child_started: match child {
            ChildStartEvidence::NeverStarted => "false",
            ChildStartEvidence::Started => "true",
            ChildStartEvidence::Ambiguous => "unknown",
        },
        ledger_state: match ledger {
            LedgerState::Unattempted => "unattempted",
            LedgerState::DurableConsumed => "durable-consumed",
            LedgerState::StickyCollision => "sticky-collision",
            LedgerState::StickyUnknown => "sticky-unknown",
        },
        sticky,
        handles_released: false,
    }
}

fn ordinary_reply(reply: KernelReply) -> Result<(), ReducerResult> {
    match reply {
        KernelReply::Ok => Ok(()),
        KernelReply::Refused(reason) => Err(stopped(
            ReducerTerminal::Refused,
            reason,
            ChildStartEvidence::NeverStarted,
            LedgerState::Unattempted,
            false,
        )),
        KernelReply::Failed(reason) => Err(stopped(
            ReducerTerminal::Failed,
            reason,
            ChildStartEvidence::NeverStarted,
            LedgerState::Unattempted,
            false,
        )),
        KernelReply::Unknown(reason) => Err(stopped(
            ReducerTerminal::Unknown,
            reason,
            ChildStartEvidence::NeverStarted,
            LedgerState::StickyUnknown,
            true,
        )),
        _ => Err(stopped(
            ReducerTerminal::Failed,
            "unexpected kernel reply",
            ChildStartEvidence::NeverStarted,
            LedgerState::Unattempted,
            false,
        )),
    }
}

fn pre_dispatch<K: LauncherKernel>(
    context: &ProductionInvocationContext,
    kernel: &mut K,
) -> Result<LedgerState, ReducerResult> {
    for step in [
        Step::ValidateFixedBinding,
        Step::FreezeImage(ImageKind::Launcher),
        Step::FreezeImage(ImageKind::Observer),
        Step::VerifyImage(ImageKind::Launcher),
        Step::VerifyImage(ImageKind::Observer),
        Step::FreezeSurface,
        Step::VerifySurface,
    ] {
        ordinary_reply(kernel.invoke(step))?;
    }
    if context.mode == Mode::Worker {
        ordinary_reply(kernel.invoke(Step::VerifySupervisorLedgerProof))?;
    }

    match kernel.invoke(Step::CreateDurableLedger) {
        KernelReply::Ok => {}
        KernelReply::LedgerCollision => {
            return Err(stopped(
                ReducerTerminal::Refused,
                "durable ledger collision is sticky consumed",
                ChildStartEvidence::NeverStarted,
                LedgerState::StickyCollision,
                true,
            ));
        }
        KernelReply::Unknown(_) | KernelReply::Failed(_) => {
            return Err(stopped(
                ReducerTerminal::Unknown,
                "durable ledger call/result/last-error is ambiguous",
                ChildStartEvidence::NeverStarted,
                LedgerState::StickyUnknown,
                true,
            ));
        }
        KernelReply::Refused(reason) => {
            return Err(stopped(
                ReducerTerminal::Refused,
                reason,
                ChildStartEvidence::NeverStarted,
                LedgerState::StickyUnknown,
                true,
            ));
        }
        _ => {
            return Err(stopped(
                ReducerTerminal::Unknown,
                "unexpected ledger result",
                ChildStartEvidence::NeverStarted,
                LedgerState::StickyUnknown,
                true,
            ));
        }
    }

    for step in [Step::FlushLedgerReadback, Step::ReopenLedgerVerify] {
        if ordinary_reply(kernel.invoke(step)).is_err() {
            return Err(stopped(
                ReducerTerminal::Unknown,
                "ledger durability or reopen readback is ambiguous",
                ChildStartEvidence::NeverStarted,
                LedgerState::StickyUnknown,
                true,
            ));
        }
    }
    Ok(LedgerState::DurableConsumed)
}

fn contextual_ok(
    reply: KernelReply,
    child: ChildStartEvidence,
    ledger: LedgerState,
    fallback: &'static str,
) -> Result<(), ReducerResult> {
    match reply {
        KernelReply::Ok | KernelReply::CancelRaceRetained => Ok(()),
        KernelReply::IoSubmitFailed { .. } => Err(stopped(
            ReducerTerminal::Failed,
            "partial I/O submission failed with operations retained",
            child,
            ledger,
            false,
        )),
        KernelReply::Refused(reason) => Err(stopped(
            ReducerTerminal::Refused,
            reason,
            child,
            ledger,
            false,
        )),
        KernelReply::Failed(reason) => Err(stopped(
            ReducerTerminal::Failed,
            reason,
            child,
            ledger,
            false,
        )),
        KernelReply::Unknown(reason) => Err(stopped(
            ReducerTerminal::Unknown,
            reason,
            child,
            LedgerState::StickyUnknown,
            true,
        )),
        _ => Err(stopped(
            ReducerTerminal::Failed,
            fallback,
            child,
            ledger,
            false,
        )),
    }
}

fn create_suspended<K: LauncherKernel>(
    kernel: &mut K,
    kind: ChildKind,
    ledger: LedgerState,
) -> Result<(), ReducerResult> {
    match kernel.invoke(Step::CreateSuspendedChild(kind)) {
        KernelReply::CreateFalseTrustworthy {
            kind: observed_kind,
            win32_error,
        } if observed_kind == kind => Err(stopped(
            ReducerTerminal::Failed,
            create_false_reason(kind, win32_error),
            ChildStartEvidence::NeverStarted,
            ledger,
            false,
        )),
        KernelReply::CreateTrue {
            process_info_valid: true,
        } => Ok(()),
        KernelReply::CreateTrue {
            process_info_valid: false,
        } => Err(stopped(
            ReducerTerminal::Unknown,
            "CreateProcess TRUE returned malformed PROCESS_INFORMATION",
            ChildStartEvidence::Ambiguous,
            LedgerState::StickyUnknown,
            true,
        )),
        KernelReply::Unknown(_) => Err(stopped(
            ReducerTerminal::Unknown,
            "child dispatch is indeterminate",
            ChildStartEvidence::Ambiguous,
            LedgerState::StickyUnknown,
            true,
        )),
        KernelReply::Refused(reason) => Err(stopped(
            ReducerTerminal::Refused,
            reason,
            ChildStartEvidence::NeverStarted,
            ledger,
            false,
        )),
        KernelReply::Failed(reason) => Err(stopped(
            ReducerTerminal::Failed,
            reason,
            ChildStartEvidence::NeverStarted,
            ledger,
            false,
        )),
        _ => Err(stopped(
            ReducerTerminal::Unknown,
            "unclassifiable child dispatch result",
            ChildStartEvidence::Ambiguous,
            LedgerState::StickyUnknown,
            true,
        )),
    }
}

fn bounded_pre_assignment_stop<K: LauncherKernel>(
    kernel: &mut K,
    reason: &'static str,
    ledger: LedgerState,
) -> ReducerResult {
    let termination = contextual_ok(
        kernel.invoke(Step::TerminateProcessOnce),
        ChildStartEvidence::Started,
        ledger,
        "terminate-process result invalid",
    );
    let reap = contextual_ok(
        kernel.invoke(Step::WaitForStableReap),
        ChildStartEvidence::Started,
        ledger,
        "reap result invalid",
    );
    if termination.is_err() || reap.is_err() {
        return stopped(
            ReducerTerminal::Quarantined,
            "pre-assignment termination or reap is ambiguous",
            ChildStartEvidence::Started,
            LedgerState::StickyUnknown,
            true,
        );
    }
    stopped(
        ReducerTerminal::Failed,
        reason,
        ChildStartEvidence::Started,
        ledger,
        false,
    )
}

fn bounded_assigned_stop<K: LauncherKernel>(
    kernel: &mut K,
    reason: &'static str,
    terminal: ReducerTerminal,
    ledger: LedgerState,
) -> ReducerResult {
    let termination = contextual_ok(
        kernel.invoke(Step::TerminateJobOnce),
        ChildStartEvidence::Started,
        ledger,
        "terminate-job result invalid",
    );
    let reap = contextual_ok(
        kernel.invoke(Step::WaitForStableReap),
        ChildStartEvidence::Started,
        ledger,
        "reap result invalid",
    );
    if termination.is_err() || reap.is_err() {
        return stopped(
            ReducerTerminal::Quarantined,
            "assigned child terminal cleanup is ambiguous",
            ChildStartEvidence::Started,
            LedgerState::StickyUnknown,
            true,
        );
    }
    stopped(terminal, reason, ChildStartEvidence::Started, ledger, true)
}

fn bounded_io_stop<K: LauncherKernel>(
    kernel: &mut K,
    reason: &'static str,
    terminal: ReducerTerminal,
    ledger: LedgerState,
) -> ReducerResult {
    let (before_io, exit_before) = kernel.io_stop_observation();
    let termination_reply = kernel.invoke(Step::TerminateJobOnce);
    let cancel_reply = kernel.invoke(Step::CancelOutstandingIo);
    let retire_reply = kernel.invoke(Step::RetireIoCompletion);
    let reap_reply = kernel.invoke(Step::WaitForStableReap);
    let (after_io, exit_after) = kernel.io_stop_observation();
    let diagnostic = IoStopDiagnostic {
        origin: IoStopOrigin::from_reason(reason).expect("closed I/O stop reason"),
        cleanup: [&termination_reply, &cancel_reply, &retire_reply, &reap_reply].map(io_cleanup_outcome),
        io: before_io.or(after_io), exit_before, exit_after,
    };
    let termination = contextual_ok(
        termination_reply,
        ChildStartEvidence::Started,
        ledger,
        "terminate-job result invalid",
    );
    let cancel = contextual_ok(
        cancel_reply,
        ChildStartEvidence::Started,
        ledger,
        "cancel result invalid",
    );
    let retire = contextual_ok(
        retire_reply,
        ChildStartEvidence::Started,
        ledger,
        "I/O retirement result invalid",
    );
    let reap = contextual_ok(
        reap_reply,
        ChildStartEvidence::Started,
        ledger,
        "reap result invalid",
    );
    let failed = termination.is_err() || cancel.is_err() || retire.is_err() || reap.is_err();
    let prefix = if failed { "terminal I/O cleanup or reap is ambiguous" } else { reason };
    let reason = format!("{prefix}; io-stop={}", serde_json::to_string(&diagnostic).expect("typed diagnostic encodes"));
    if failed {
        return stopped(
            ReducerTerminal::Quarantined,
            reason,
            ChildStartEvidence::Started,
            LedgerState::StickyUnknown,
            true,
        );
    }
    stopped(terminal, reason, ChildStartEvidence::Started, ledger, true)
}

fn start_supervised_child<K: LauncherKernel>(
    kernel: &mut K,
    ledger: LedgerState,
) -> Result<(), ReducerResult> {
    for step in [
        Step::CreateOuterJob(OUTER_JOB_LIMITS),
        Step::VerifyOuterJob(OUTER_JOB_LIMITS),
        Step::BeginPinnedOverlappedPipes,
        Step::GateSeIncreaseQuota,
    ] {
        contextual_ok(
            kernel.invoke(step),
            ChildStartEvidence::NeverStarted,
            ledger,
            "outer job setup failed",
        )?;
    }
    create_suspended(kernel, ChildKind::Worker, ledger)?;
    if contextual_ok(
        kernel.invoke(Step::AssignOuterJob),
        ChildStartEvidence::Started,
        ledger,
        "outer job assignment failed",
    )
    .is_err()
    {
        return Err(bounded_pre_assignment_stop(
            kernel,
            "worker was not assigned to outer job",
            ledger,
        ));
    }
    for step in [
        Step::VerifyOuterMembership,
        Step::VerifyImage(ImageKind::Launcher),
    ] {
        let failure_reason = match step {
            Step::VerifyOuterMembership => "worker outer membership verification failed",
            _ => "worker launcher image reverify failed",
        };
        if contextual_ok(
            kernel.invoke(step),
            ChildStartEvidence::Started,
            ledger,
            failure_reason,
        )
        .is_err()
        {
            return Err(bounded_assigned_stop(
                kernel,
                failure_reason,
                ReducerTerminal::Failed,
                ledger,
            ));
        }
    }
    match kernel.invoke(Step::ResumePrimaryThread) {
        KernelReply::ResumeCount(1) => {}
        _ => {
            return Err(bounded_assigned_stop(
                kernel,
                "worker resume count was not exactly one",
                ReducerTerminal::Unknown,
                ledger,
            ));
        }
    }
    match kernel.invoke(Step::SampleThreadCount) {
        KernelReply::ThreadCount(count) if count <= THREAD_SAMPLE_LIMIT => Ok(()),
        _ => Err(bounded_assigned_stop(
            kernel,
            "sampled worker thread limit exceeded or was ambiguous",
            ReducerTerminal::Failed,
            ledger,
        )),
    }
}

fn start_worker_observer<K: LauncherKernel>(
    kernel: &mut K,
    ledger: LedgerState,
) -> Result<(), ReducerResult> {
    for step in [
        Step::VerifyAlreadyOuterContained,
        Step::CreateInnerJob(INNER_JOB_LIMITS),
        Step::VerifyInnerJob(INNER_JOB_LIMITS),
        Step::GateSeIncreaseQuota,
        Step::CreateRestrictedPrimaryToken {
            rights: TOKEN_RIGHTS,
            policy: RESTRICTED_TOKEN_POLICY,
        },
        Step::SetLowIntegrity,
        Step::DeriveRegularAppContainerSid,
        Step::VerifyAppContainerZeroCapabilities,
        Step::VerifyLoopbackNonExempt,
        Step::BeginPinnedOverlappedPipes,
    ] {
        contextual_ok(
            kernel.invoke(step),
            ChildStartEvidence::NeverStarted,
            ledger,
            "worker security setup failed closed",
        )?;
    }
    create_suspended(kernel, ChildKind::Observer, ledger)?;
    if contextual_ok(
        kernel.invoke(Step::AssignInnerJob),
        ChildStartEvidence::Started,
        ledger,
        "inner job assignment failed",
    )
    .is_err()
    {
        return Err(bounded_pre_assignment_stop(
            kernel,
            "observer was not assigned to inner job",
            ledger,
        ));
    }
    for step in [
        Step::VerifyObserverConfinement,
        Step::VerifyOuterMembership,
        Step::VerifyImage(ImageKind::Observer),
        Step::VerifySurface,
    ] {
        let failure_reason = match step {
            Step::VerifyObserverConfinement => {
                "observer token and job confinement verification failed"
            }
            Step::VerifyOuterMembership => "observer outer membership verification failed",
            Step::VerifyImage(ImageKind::Observer) => "observer image reverify failed",
            _ => "observer surface reverify failed",
        };
        if contextual_ok(
            kernel.invoke(step),
            ChildStartEvidence::Started,
            ledger,
            failure_reason,
        )
        .is_err()
        {
            return Err(bounded_assigned_stop(
                kernel,
                failure_reason,
                ReducerTerminal::Failed,
                ledger,
            ));
        }
    }
    match kernel.invoke(Step::ResumePrimaryThread) {
        KernelReply::ResumeCount(1) => {}
        _ => {
            return Err(bounded_assigned_stop(
                kernel,
                "observer resume count was not exactly one",
                ReducerTerminal::Unknown,
                ledger,
            ));
        }
    }
    match kernel.invoke(Step::SampleThreadCount) {
        KernelReply::ThreadCount(count) if count <= THREAD_SAMPLE_LIMIT => Ok(()),
        _ => Err(bounded_assigned_stop(
            kernel,
            "sampled observer thread limit exceeded or was ambiguous",
            ReducerTerminal::Failed,
            ledger,
        )),
    }
}

pub fn drain_cutoff(first_terminal_ms: u64, earliest_deadline_ms: u64) -> u64 {
    first_terminal_ms
        .saturating_add(DRAIN_GRACE_MS)
        .min(earliest_deadline_ms.saturating_add(DRAIN_GRACE_MS))
}

pub fn deadline_wins_tie(now_ms: u64, deadline_ms: u64) -> bool {
    now_ms >= deadline_ms
}

fn stream_is_eof(reply: KernelReply, cap: usize, require_zero: bool) -> bool {
    match reply {
        KernelReply::EofBytes(bytes) => bytes.len() <= cap && (!require_zero || bytes.is_empty()),
        KernelReply::Eof {
            bytes,
            canonical_frame,
        }
        | KernelReply::BrokenPipe {
            bytes,
            canonical_frame,
        } => bytes <= cap && (!require_zero || bytes == 0) && (bytes == 0 || canonical_frame),
        _ => false,
    }
}

fn run_bounded_io<K: LauncherKernel>(
    context: &ProductionInvocationContext,
    kernel: &mut K,
    ledger: LedgerState,
) -> ReducerResult {
    if contextual_ok(
        kernel.invoke(Step::StartConcurrentIo),
        ChildStartEvidence::Started,
        ledger,
        "pipe setup failed",
    )
    .is_err()
    {
        return bounded_io_stop(
            kernel,
            "concurrent overlapped I/O start failed",
            ReducerTerminal::Failed,
            ledger,
        );
    }

    match kernel.invoke(Step::Transfer(StreamKind::Stdin)) {
        KernelReply::TransferComplete { bytes }
        | KernelReply::BrokenPipe {
            bytes,
            canonical_frame: _,
        } if bytes == context.canonical_request_bytes.len() => {}
        _ => {
            return bounded_io_stop(
                kernel,
                "stdin broke before every byte completed",
                ReducerTerminal::Failed,
                ledger,
            );
        }
    }
    let stdout_cap = if context.mode == Mode::Supervisor {
        MAX_WORKER_RESULT_BYTES
    } else {
        MAX_STDOUT_BYTES
    };
    if !stream_is_eof(
        kernel.invoke(Step::Transfer(StreamKind::Stdout)),
        stdout_cap,
        false,
    ) {
        return bounded_io_stop(
            kernel,
            "stdout was not bounded canonical EOF",
            ReducerTerminal::Failed,
            ledger,
        );
    }
    if !stream_is_eof(
        kernel.invoke(Step::Transfer(StreamKind::Stderr)),
        MAX_STDERR_BYTES,
        true,
    ) {
        return bounded_io_stop(
            kernel,
            "stderr was nonzero or not EOF",
            ReducerTerminal::Failed,
            ledger,
        );
    }
    match kernel.invoke(Step::PollProcess) {
        KernelReply::ExitCode(code) if code != 259 => {}
        KernelReply::StillActive | KernelReply::ExitCode(259) => {
            return bounded_io_stop(
                kernel,
                "process remained STILL_ACTIVE",
                ReducerTerminal::Failed,
                ledger,
            );
        }
        KernelReply::DeadlineReached => {
            return bounded_io_stop(
                kernel,
                "process did not exit before deadline",
                ReducerTerminal::Deadline,
                ledger,
            );
        }
        _ => {
            return bounded_io_stop(
                kernel,
                "process exit was ambiguous",
                ReducerTerminal::Unknown,
                ledger,
            );
        }
    }
    if kernel.invoke(Step::VerifySignaledProcess) != KernelReply::MatchingProcess {
        return bounded_io_stop(
            kernel,
            "signaled process did not match the launched process",
            ReducerTerminal::Unknown,
            ledger,
        );
    }
    if kernel.invoke(Step::RecheckDeadline) != KernelReply::DeadlineNotReached {
        return bounded_io_stop(
            kernel,
            "deadline won the terminal tie",
            ReducerTerminal::Deadline,
            ledger,
        );
    }

    for step in [
        Step::RetireIoCompletion,
        Step::WaitForStableReap,
        Step::FinalIdentityAclHashReverify,
        Step::ReopenDurableEvidence,
        Step::ReleaseHeldImageHandles,
    ] {
        if contextual_ok(
            kernel.invoke(step),
            ChildStartEvidence::Started,
            ledger,
            "final release precondition failed",
        )
        .is_err()
        {
            return stopped(
                ReducerTerminal::Quarantined,
                "ambiguous reap or final identity/evidence state",
                ChildStartEvidence::Started,
                LedgerState::StickyUnknown,
                true,
            );
        }
    }

    ReducerResult {
        terminal: ReducerTerminal::Success,
        reason: "bounded fixed launcher invocation succeeded".into(),
        invocation_attempt_count: 1,
        child_start_evidence: ChildStartEvidence::Started,
        child_started: "true",
        ledger_state: "durable-consumed",
        sticky: false,
        handles_released: true,
    }
}

pub fn run_reducer<K: LauncherKernel>(
    context: &ProductionInvocationContext,
    kernel: &mut K,
) -> ReducerResult {
    if let Err(result) = contextual_ok(
        kernel.bind_context(context),
        ChildStartEvidence::NeverStarted,
        LedgerState::Unattempted,
        "production invocation context binding failed",
    ) {
        return result;
    }
    let ledger = match pre_dispatch(context, kernel) {
        Ok(ledger) => ledger,
        Err(result) => return result,
    };
    let started = match context.mode {
        Mode::Supervisor => start_supervised_child(kernel, ledger),
        Mode::Worker => start_worker_observer(kernel, ledger),
    };
    if let Err(result) = started {
        return result;
    }
    run_bounded_io(context, kernel, ledger)
}

pub fn close_result(
    context: &ProductionInvocationContext,
    reducer: ReducerResult,
) -> LauncherResult {
    let evidence = conservative_wire_evidence(reducer.child_start_evidence);
    close_result_with_evidence(context, reducer, evidence)
}

pub fn close_result_with_evidence(
    context: &ProductionInvocationContext,
    reducer: ReducerResult,
    evidence: LauncherWireEvidenceV1,
) -> LauncherResult {
    debug_assert!(validate_wire_evidence(&evidence).is_ok());
    LauncherResult {
        schema: RESULT_SCHEMA.into(),
        request_id: context.envelope.request_id.clone(),
        correlation_id: context.envelope.correlation_id.clone(),
        carrier_sha256: context.envelope.carrier_sha256.clone(),
        observer_image_sha256: context.envelope.observer_image_sha256.clone(),
        stdin_sha256: context.envelope.stdin_sha256.clone(),
        deadline_ms: context.envelope.deadline_ms,
        ledger_identity_sha256: context.ledger_identity_sha256.clone(),
        terminal: reducer.terminal,
        reason: reducer.reason.into(),
        invocation_attempt_count: reducer.invocation_attempt_count,
        child_start_evidence: reducer.child_start_evidence,
        child_started: reducer.child_started.into(),
        ledger_state: reducer.ledger_state.into(),
        sticky: reducer.sticky,
        handles_released: reducer.handles_released,
        evidence,
    }
}

pub fn run_and_close<K: LauncherKernel>(
    context: &ProductionInvocationContext,
    kernel: &mut K,
) -> LauncherResult {
    let mut reducer = run_reducer(context, kernel);
    if kernel.finalize_invocation().is_err() {
        let reason = if reducer.terminal == ReducerTerminal::Success {
            DRIVE_BINDING_FAILURE.to_owned()
        } else {
            reducer.reason.to_string()
        };
        reducer = stopped(ReducerTerminal::Quarantined, reason, reducer.child_start_evidence,
            LedgerState::StickyUnknown, true);
    }
    let promoted_worker_outcome = kernel.promoted_worker_outcome();
    let evidence = match kernel.snapshot_evidence(context, reducer.child_start_evidence) {
        Ok(evidence) if validate_wire_evidence(&evidence).is_ok() => evidence,
        rejected_snapshot => {
            let snapshot_category = match rejected_snapshot {
                Ok(_) => "invalid-wire-evidence",
                Err("supervisor has no validated worker evidence to promote") => {
                    "missing-worker-promotion"
                }
                Err("evidence snapshot context differs" | "context not bound") => "context-mismatch",
                Err(_) => "snapshot-refused",
            };
            let promotion = kernel.worker_promotion_diagnostic();
            let worker_category = match promotion {
                WorkerPromotionDiagnostic::TerminalTupleRejected { worker_category }
                | WorkerPromotionDiagnostic::IoStopRejected { worker_category, .. } => {
                    worker_category
                }
                _ => "unavailable",
            };
            // The reducer's terminal still wins; this only records its bounded
            // original category before the existing snapshot quarantine replaces it.
            let mut reason = format!(
                "invocation evidence snapshot or promotion failed; reducer={}; reducer-terminal={:?}; snapshot={snapshot_category}; promotion={}; bound-worker={worker_category}",
                bounded_failure_category(&reducer.reason),
                reducer.terminal,
                promotion.label(),
            );
            // Prefer the context-validated worker observation at this boundary;
            // otherwise retain the local I/O observation. Never echo raw reasons.
            if let WorkerPromotionDiagnostic::IoStopRejected { diagnostic, .. } = promotion {
                reason.push_str("; worker-io-stop=");
                reason.push_str(&serde_json::to_string(&diagnostic).expect("typed diagnostic encodes"));
            } else if let Some((_, diagnostic)) = parse_io_stop_reason(&reducer.reason) {
                reason.push_str("; io-stop=");
                reason.push_str(&serde_json::to_string(&diagnostic).expect("typed diagnostic encodes"));
            }
            let evidence_child = if context.mode == Mode::Supervisor
                && reducer.child_start_evidence == ChildStartEvidence::Started
            {
                ChildStartEvidence::Ambiguous
            } else {
                reducer.child_start_evidence
            };
            reducer = stopped(
                ReducerTerminal::Quarantined,
                reason,
                reducer.child_start_evidence,
                LedgerState::StickyUnknown,
                true,
            );
            conservative_wire_evidence(evidence_child)
        }
    };
    let mut result = close_result_with_evidence(context, reducer, evidence);
    if context.mode == Mode::Supervisor && result.terminal == ReducerTerminal::Success {
        if let Some((terminal, reason)) = promoted_worker_outcome {
            if terminal != ReducerTerminal::Success {
                result.terminal = terminal;
                result.reason = reason;
            }
        }
    }
    result
}

#[cfg(all(windows, test))]
pub(crate) mod native_process_signal_fixture {
    use super::*;
    use std::{
        os::windows::io::AsRawHandle,
        process::{Child, Command, Stdio},
        sync::mpsc,
        thread,
        time::{Duration, Instant as WallInstant},
    };
    use windows_sys::Win32::Foundation::{DuplicateHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Console::{
        GetStdHandle, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE, SetStdHandle,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentThread, GetProcessId};

    const CHILD_MODE: &str = "RM0032_PROCESS_SIGNAL_FIXTURE_MODE";

    fn spawn_eof_blocked_child(selector: &str) -> Child {
        let mut child = Command::new(std::env::current_exe().expect("current test executable"))
            .args([
                "--exact",
                selector,
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(CHILD_MODE, "wait-stdin-eof")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn inert raw-handle fixture child");

        let mut stdout = child.stdout.take().expect("fixture stdout pipe");
        let mut stderr = child.stderr.take().expect("fixture stderr pipe");
        let (tx, rx) = mpsc::channel();
        let stdout_tx = tx.clone();
        let stdout_reader = thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = stdout.read_to_end(&mut bytes).map(|_| bytes.len());
            let _ = stdout_tx.send(("stdout", result));
        });
        let stderr_reader = thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = stderr.read_to_end(&mut bytes).map(|_| bytes.len());
            let _ = tx.send(("stderr", result));
        });

        let mut observations = Vec::new();
        for _ in 0..2 {
            match rx.recv_timeout(Duration::from_secs(2)) {
                Ok((name, Ok(bytes))) => observations.push((name, bytes)),
                Ok((name, Err(error))) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_reader.join();
                    let _ = stderr_reader.join();
                    panic!("{name} fixture read failed: {error}");
                }
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_reader.join();
                    let _ = stderr_reader.join();
                    panic!("raw-handle EOF fixture timed out: {error}");
                }
            }
        }
        stdout_reader.join().expect("stdout reader joins");
        stderr_reader.join().expect("stderr reader joins");
        observations.sort_by_key(|entry| entry.0);
        assert_eq!(
            observations.iter().map(|entry| entry.0).collect::<Vec<_>>(),
            ["stderr", "stdout"]
        );
        match child.try_wait().expect("query EOF fixture child") {
            None => child,
            Some(status) => panic!("EOF was observed only after child exit: {status}"),
        }
    }

    fn duplicate_child_process(child: &Child) -> OwnedNativeHandle {
        let mut duplicate = null_mut();
        let source = child.as_raw_handle() as HANDLE;
        assert_ne!(
            unsafe {
                DuplicateHandle(
                    GetCurrentProcess(),
                    source,
                    GetCurrentProcess(),
                    &mut duplicate,
                    0,
                    0,
                    2,
                )
            },
            0,
            "duplicate exact child process handle"
        );
        assert_eq!(unsafe { GetProcessId(duplicate) }, child.id());
        OwnedNativeHandle::new(duplicate, TypedHandleKind::Process)
            .expect("owned exact child process handle")
    }

    fn duplicate_current_thread() -> OwnedNativeHandle {
        let mut duplicate = null_mut();
        assert_ne!(
            unsafe {
                DuplicateHandle(
                    GetCurrentProcess(),
                    GetCurrentThread(),
                    GetCurrentProcess(),
                    &mut duplicate,
                    0,
                    0,
                    2,
                )
            },
            0,
            "duplicate fixture thread handle"
        );
        OwnedNativeHandle::new(duplicate, TypedHandleKind::Thread)
            .expect("owned fixture thread handle")
    }

    fn kernel_for_child(child: &Child, deadline_ms: u64, elapsed_ms: u64) -> RealWin32Kernel {
        let mut context = native_privilege_boundary_tests::context();
        context.envelope.deadline_ms = deadline_ms;
        let now = Instant::now();
        let started = now
            .checked_sub(Duration::from_millis(elapsed_ms))
            .expect("fixture monotonic start");
        let mut kernel = RealWin32Kernel::default();
        kernel.context = Some(context);
        kernel.bound_at = Some(started);
        kernel.first_terminal_at = Some(now);
        kernel.child = Some(NativeChild {
            process: duplicate_child_process(child),
            thread: duplicate_current_thread(),
            process_id: child.id(),
            kind: ChildKind::Worker,
            assigned: true,
            resumed: true,
            containment: ContainmentState::ResumedExactlyOnce,
        });
        kernel
    }

    fn release_stdin_after(child: &mut Child, delay: Duration) -> thread::JoinHandle<()> {
        let stdin = child.stdin.take().expect("held fixture stdin writer");
        thread::spawn(move || {
            thread::sleep(delay);
            drop(stdin);
        })
    }

    pub fn eof_before_process_signal_uses_partially_spent_work_budget(selector: &str) {
        let mut child = spawn_eof_blocked_child(selector);
        let mut kernel = kernel_for_child(&child, 1_500, 400);
        let process_handle = kernel.child.as_ref().unwrap().process.raw() as usize;
        let release = release_stdin_after(&mut child, Duration::from_millis(80));
        native_budget_fixture_hook::observe_actual();
        let started = WallInstant::now();
        let reply = kernel.invoke(Step::PollProcess);
        let elapsed = started.elapsed();
        let waits = native_budget_fixture_hook::take();
        release.join().expect("stdin release joins");
        let status = child.wait().expect("reap EOF fixture child");
        assert!(status.success());
        assert_eq!(reply, KernelReply::ExitCode(0));
        assert!(kernel.process_signaled);
        assert!(elapsed >= Duration::from_millis(40));
        assert!(elapsed < Duration::from_millis(1_100));
        assert_eq!(waits.len(), 1);
        assert_eq!(waits[0].0, process_handle);
        assert!(waits[0].1 > 0 && waits[0].1 <= 1_100);
        assert_eq!(waits[0].2, WAIT_OBJECT_0);
        println!(
            "NATIVE_PROCESS_SIGNAL_WAIT_PASS eof_while_live=true elapsed_ms={} timeout_ms={} partially_spent=true",
            elapsed.as_millis(),
            waits[0].1
        );
    }

    pub fn process_wait_does_not_spend_cleanup_grace(selector: &str) {
        let mut child = spawn_eof_blocked_child(selector);
        let mut kernel = kernel_for_child(&child, 75, 0);
        let release = release_stdin_after(&mut child, Duration::from_millis(250));
        native_budget_fixture_hook::observe_actual();
        let started = WallInstant::now();
        let reply = kernel.invoke(Step::PollProcess);
        let elapsed = started.elapsed();
        let waits = native_budget_fixture_hook::take();
        let live_at_return = child
            .try_wait()
            .expect("query over-deadline child")
            .is_none();
        release.join().expect("late stdin release joins");
        let status = child.wait().expect("reap over-deadline child");
        assert!(status.success());
        assert!(live_at_return);
        assert_eq!(reply, KernelReply::DeadlineReached);
        assert!(elapsed < Duration::from_millis(200));
        assert_eq!(waits.len(), 1);
        assert!(waits[0].1 > 0 && waits[0].1 <= 75);
        assert_eq!(waits[0].2, WAIT_TIMEOUT);
        println!(
            "NATIVE_PROCESS_WORK_DEADLINE_PASS live_at_return=true elapsed_ms={} timeout_ms={} cleanup_grace_used=false",
            elapsed.as_millis(),
            waits[0].1
        );
    }

    pub fn expired_process_budget_performs_no_wait(selector: &str) {
        let mut child = spawn_eof_blocked_child(selector);
        let mut kernel = kernel_for_child(&child, 50, 100);
        native_budget_fixture_hook::observe_actual();
        let reply = kernel.invoke(Step::PollProcess);
        let waits = native_budget_fixture_hook::take();
        drop(child.stdin.take());
        let status = child.wait().expect("reap expired-budget child");
        assert!(status.success());
        assert_eq!(reply, KernelReply::DeadlineReached);
        assert!(waits.is_empty());
        println!("NATIVE_PROCESS_EXPIRED_PASS wait_calls=0 terminal=DeadlineReached");
    }

    pub fn invalid_process_handle_reports_wait_error(selector: &str) {
        let mut child = spawn_eof_blocked_child(selector);
        let mut kernel = kernel_for_child(&child, 1_000, 0);
        let raw = kernel.child.as_ref().unwrap().process.raw();
        if unsafe { CloseHandle(raw) } == 0 {
            drop(child.stdin.take());
            let _ = child.wait();
            panic!("fixture process handle close failed");
        }
        native_budget_fixture_hook::observe_actual();
        let reply = kernel.invoke(Step::PollProcess);
        let waits = native_budget_fixture_hook::take();
        let NativeChild {
            process, thread, ..
        } = kernel.child.take().unwrap();
        std::mem::forget(process);
        drop(thread);
        drop(child.stdin.take());
        let status = child.wait().expect("reap wait-error child");
        assert!(status.success());
        assert_eq!(reply, KernelReply::Unknown("process wait poll failed"));
        assert_eq!(waits.len(), 1);
        assert_eq!(waits[0].0, raw as usize);
        assert_eq!(waits[0].2, u32::MAX);
        println!("NATIVE_PROCESS_WAIT_ERROR_PASS wait_failed=true fail_closed=unknown");
    }

    pub fn signaled_wait_still_allows_deadline_tie(selector: &str) {
        let mut child = spawn_eof_blocked_child(selector);
        let mut kernel = kernel_for_child(&child, 150, 0);
        let release = release_stdin_after(&mut child, Duration::from_millis(50));
        native_budget_fixture_hook::observe_actual();
        let reply = kernel.invoke(Step::PollProcess);
        let waits = native_budget_fixture_hook::take();
        release.join().expect("tie stdin release joins");
        let status = child.wait().expect("reap deadline-tie child");
        let remaining = kernel.deadline_timeout_ms(false).unwrap_or(0);
        thread::sleep(Duration::from_millis(u64::from(remaining) + 10));
        let tie = kernel.invoke(Step::RecheckDeadline);
        assert!(status.success());
        assert_eq!(reply, KernelReply::ExitCode(0));
        assert_eq!(waits.len(), 1);
        assert_eq!(waits[0].2, WAIT_OBJECT_0);
        assert_eq!(tie, KernelReply::DeadlineReached);
        println!("NATIVE_PROCESS_DEADLINE_TIE_PASS signaled=true tie=deadline");
    }

    pub fn signaled_exit_code_259_remains_fail_closed(selector: &str) {
        let mut child = Command::new(std::env::current_exe().expect("current test executable"))
            .args([
                "--exact",
                selector,
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(CHILD_MODE, "exit-259")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn exit-259 fixture child");
        let mut kernel = kernel_for_child(&child, 1_000, 0);
        let status = child.wait().expect("reap exit-259 child");
        assert_eq!(status.code(), Some(259));
        kernel.bound_at = Some(Instant::now());
        native_budget_fixture_hook::observe_actual();
        let reply = kernel.invoke(Step::PollProcess);
        let waits = native_budget_fixture_hook::take();
        assert_eq!(reply, KernelReply::StillActive);
        assert!(kernel.process_signaled);
        assert_eq!(waits.len(), 1);
        assert_eq!(waits[0].2, WAIT_OBJECT_0);
        println!("NATIVE_PROCESS_EXIT_259_PASS signaled=true fail_closed=still-active");
    }

    pub fn raw_stdio_eof_child() {
        assert_eq!(std::env::var(CHILD_MODE).as_deref(), Ok("wait-stdin-eof"));
        let stdout = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
        let stderr = unsafe { GetStdHandle(STD_ERROR_HANDLE) };
        if stdout.is_null()
            || stderr.is_null()
            || stdout == INVALID_HANDLE_VALUE
            || stderr == INVALID_HANDLE_VALUE
        {
            std::process::exit(91);
        }
        if unsafe { CloseHandle(stdout) } == 0
            || unsafe { SetStdHandle(STD_OUTPUT_HANDLE, null_mut()) } == 0
            || unsafe { CloseHandle(stderr) } == 0
            || unsafe { SetStdHandle(STD_ERROR_HANDLE, null_mut()) } == 0
        {
            std::process::exit(92);
        }
        let mut byte = [0u8; 1];
        match std::io::stdin().read(&mut byte) {
            Ok(0) => std::process::exit(0),
            _ => std::process::exit(93),
        }
    }

    pub fn exit_259_child() {
        assert_eq!(std::env::var(CHILD_MODE).as_deref(), Ok("exit-259"));
        std::process::exit(259);
    }
}

#[cfg(all(windows, test))]
pub(crate) mod native_stdin_fixture {
    use super::*;
    use std::{
        fs::File,
        mem::ManuallyDrop,
        os::windows::io::FromRawHandle,
        sync::mpsc,
        thread,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    fn empty_io() -> NativeIoBundle {
        NativeIoBundle {
            stdin: None,
            stdout: None,
            stderr: None,
            stdout_bytes: vec![],
            stderr_bytes: vec![],
            stdin_state: PipeState::Uninitialized,
            stdout_state: PipeState::Open,
            stderr_state: PipeState::Open,
            stdout_eof: false,
            stdout_cap_exceeded: false,
            stderr_eof: false,
            stderr_nonzero_seen: false,
            retired: false,
        }
    }

    fn budget_kernel() -> RealWin32Kernel {
        let mut context = native_privilege_boundary_tests::context();
        context.envelope.deadline_ms = 10000;
        let mut kernel = RealWin32Kernel::default();
        kernel.context = Some(context);
        let started = Instant::now() - Duration::from_millis(5800);
        kernel.bound_at = Some(started);
        kernel.first_terminal_at = Some(started + Duration::from_millis(1000));
        kernel
    }

    fn pending_read(label: &str) -> (OwnedNativeHandle, OwnedNativeHandle, NativePendingIo) {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let (read, write) = native_pipe_pair(
            &format!(
                r"\\.\pipe\DecadansOfflineBudgetG5-{}-{nonce}-{label}",
                std::process::id()
            ),
            true,
            TypedHandleKind::StdoutRead,
            TypedHandleKind::StdoutWrite,
        )
        .unwrap();
        let mut pending =
            NativePendingIo::prepared(read.raw(), NativeIoDirection::Read, vec![0; 32]).unwrap();
        pending.submit().unwrap();
        assert_eq!(pending.state, NativeOperationState::Pending);
        (read, write, pending)
    }

    pub fn stdin_incomplete_paths_keep_the_writer_owned() {
        for case in ["pending", "count-mismatch", "broken-reader", "completion-232"] {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let name = format!(
                r"\\.\pipe\DecadansOfflineStdinHostileG5-{}-{nonce}-{case}",
                std::process::id()
            );
            let (writer, reader) = native_pipe_pair(
                &name,
                false,
                TypedHandleKind::StdinWrite,
                TypedHandleKind::StdinRead,
            )
            .unwrap();
            let (out_read, out_write) = native_pipe_pair(
                &format!("{name}-out"),
                true,
                TypedHandleKind::StdoutRead,
                TypedHandleKind::StdoutWrite,
            )
            .unwrap();
            let (err_read, err_write) = native_pipe_pair(
                &format!("{name}-err"),
                true,
                TypedHandleKind::StderrRead,
                TypedHandleKind::StderrWrite,
            )
            .unwrap();
            let mut reader = Some(reader);
            if case == "broken-reader" {
                drop(reader.take());
            }
            let bytes = vec![
                b'x';
                if case == "pending" {
                    MAX_STDOUT_BYTES + 8192
                } else {
                    8
                }
            ];
            let mut op =
                NativePendingIo::prepared(writer.raw(), NativeIoDirection::Write, bytes).unwrap();
            let submitted = op.submit();
            if case == "pending" {
                submitted.unwrap();
                assert_eq!(op.state, NativeOperationState::Pending);
            } else if case == "count-mismatch" || case == "completion-232" {
                submitted.unwrap();
                assert_eq!(op.finish(1000).unwrap(), 8);
                // Change the expected byte count only AFTER real terminal completion.
                // This exercises short-count refusal, not a claim of an OS short write.
                if case == "count-mismatch" {
                    op.buffer.push(b'!');
                } else {
                    // Actual operation completed first. Inject completion-error
                    // provenance, never claim the OS produced completion 232.
                    op.state = NativeOperationState::TerminalError(232);
                    op.failure = Some((IoDiagnosticApi::Completion, 232));
                }
            } else {
                assert!(submitted.is_err());
                assert_eq!(op.state, NativeOperationState::InitialWriteNoData);
            }
            let mut kernel = budget_kernel();
            kernel.bound_at = Some(Instant::now());
            kernel.first_terminal_at = None;
            kernel.context.as_mut().unwrap().envelope.deadline_ms = 20;
            kernel.pipes = Some(NativePipeHandles {
                parent_stdin_write: Some(writer),
                parent_stdout_read: out_read,
                parent_stderr_read: err_read,
                child_stdin_read: None,
                child_stdout_write: Some(out_write),
                child_stderr_write: Some(err_write),
            });
            let mut io = empty_io();
            io.stdin = Some(op);
            io.stdin_state = PipeState::Open;
            kernel.io = Some(io);
            let result = kernel.transfer_stdin();
            let before = kernel.io_stop_observation().0;
            assert!(kernel.pipes.as_ref().unwrap().parent_stdin_write.is_some());
            assert!(kernel.io.as_ref().unwrap().stdin.is_some());
            match case {
                "pending" => assert_eq!(result, KernelReply::DeadlineReached),
                "count-mismatch" => {
                    assert!(matches!(result, KernelReply::BrokenPipe { bytes: 8, .. }))
                }
                _ => assert!(!matches!(result, KernelReply::TransferComplete { .. })),
            }
            kernel.cancel_outstanding_io().unwrap();
            let retired = kernel.retire_io();
            if case == "completion-232" {
                // Same numeric error with completion provenance must not acquire
                // the initial-write, never-pending retirement exception.
                assert!(retired.is_err());
                assert!(!kernel.io.as_ref().unwrap().retired);
                assert!(
                    kernel
                        .io
                        .as_ref()
                        .unwrap()
                        .stdin
                        .as_ref()
                        .unwrap()
                        .is_terminal()
                );
            } else {
                retired.unwrap();
                assert!(kernel.io.as_ref().unwrap().retired);
            }
            if case == "broken-reader" {
                let fault = before.unwrap();
                assert_eq!(fault.api, IoDiagnosticApi::WriteSubmit);
                assert_eq!(fault.code, 232);
                assert_eq!(fault.state, IoDiagnosticState::InitialWriteNoData);
                assert!(!matches!(result, KernelReply::TransferComplete { .. }));
            }
            println!("NATIVE_IO_STOP_RETIREMENT {}", serde_json::json!({
                "case": case, "before": before,
                "retired": kernel.io.as_ref().unwrap().retired,
                "completion_error_is_injected": case == "completion-232",
                "transfer_succeeded": matches!(result, KernelReply::TransferComplete { .. })
            }));
            drop(kernel.io.take());
            drop(kernel.pipes.take());
            drop(reader);
            println!(
                "NATIVE_STDIN_HOSTILE_PASS case={case} writer_preserved_until_terminal_cleanup=true retirement_refusal_preserved={}",
                case == "completion-232"
            );
        }
    }

    pub fn cleanup_budget_is_shared_by_real_waits() {
        let (read1, write1, pending1) = pending_read("one");
        let (read2, write2, pending2) = pending_read("two");
        let events = [pending1.event.raw() as usize, pending2.event.raw() as usize];
        for writer in [&write1, &write2] {
            let mut count = 0;
            assert_ne!(
                unsafe { WriteFile(writer.raw(), b"x".as_ptr(), 1, &mut count, null_mut()) },
                0
            );
            assert_eq!(count, 1);
        }
        // Events/completions are real. Only elapsed input advances between the actual waits.
        let mut kernel = budget_kernel();
        let mut io = empty_io();
        io.stdout = Some(pending1);
        io.stderr = Some(pending2);
        kernel.io = Some(io);
        native_budget_fixture_hook::arm(5800, &[5990, 6000]);
        let retired = kernel.retire_io();
        use windows_sys::Win32::Foundation::DuplicateHandle;
        use windows_sys::Win32::System::Threading::GetCurrentThread;
        let mut process = null_mut();
        let mut thread = null_mut();
        assert_ne!(
            unsafe {
                DuplicateHandle(
                    GetCurrentProcess(),
                    GetCurrentProcess(),
                    GetCurrentProcess(),
                    &mut process,
                    0,
                    0,
                    2,
                )
            },
            0
        );
        assert_ne!(
            unsafe {
                DuplicateHandle(
                    GetCurrentProcess(),
                    GetCurrentThread(),
                    GetCurrentProcess(),
                    &mut thread,
                    0,
                    0,
                    2,
                )
            },
            0
        );
        let process_raw = process as usize;
        kernel.child = Some(NativeChild {
            process: OwnedNativeHandle::new(process, TypedHandleKind::Process).unwrap(),
            thread: OwnedNativeHandle::new(thread, TypedHandleKind::Thread).unwrap(),
            process_id: std::process::id(),
            kind: ChildKind::Worker,
            assigned: false,
            resumed: false,
            containment: ContainmentState::SuspendedUnassigned,
        });
        let reap = kernel.invoke(Step::WaitForStableReap);
        let waits = native_budget_fixture_hook::take();
        assert!(retired.is_ok());
        assert!(kernel.io.as_ref().unwrap().retired);
        assert_eq!(
            waits,
            vec![
                (events[0], 200, WAIT_OBJECT_0),
                (events[1], 10, WAIT_OBJECT_0),
                (process_raw, 0, WAIT_TIMEOUT)
            ]
        );
        assert_eq!(reap, KernelReply::Unknown("bounded process reap timed out"));
        drop((read1, write1, read2, write2));
        println!(
            "NATIVE_CLEANUP_BUDGET_PASS real_waits=3 timeouts=200,10,0 process_handle=self-duplicate"
        );
    }

    pub fn expired_cleanup_retains_pending_operation() {
        let (read, writer, pending) = pending_read("expired");
        let event = pending.event.raw() as usize;
        let mut kernel = budget_kernel();
        let mut io = empty_io();
        io.stdout = Some(pending);
        kernel.io = Some(io);
        native_budget_fixture_hook::arm(6000, &[]);
        let retired = kernel.retire_io();
        let waits = native_budget_fixture_hook::take();
        let remained_pending = kernel.io.as_ref().unwrap().stdout.as_ref().unwrap().state
            == NativeOperationState::Pending;
        let falsely_retired = kernel.io.as_ref().unwrap().retired;
        // Teardown is separate evidence: real cancellation retires the still-owned operation.
        kernel.cancel_outstanding_io().unwrap();
        kernel.retire_io().unwrap();
        assert!(kernel.io.as_ref().unwrap().retired);
        drop((read, writer));
        assert!(retired.is_err());
        assert!(remained_pending && !falsely_retired);
        assert_eq!(waits, vec![(event, 0, WAIT_TIMEOUT)]);
        println!(
            "NATIVE_EXPIRED_CLEANUP_PASS timeout=0 pending_preserved=true teardown_cancelled=true"
        );
    }

    pub fn early_terminal_still_bounds_pending_stderr() {
        let (out_read, out_writer, out_pending) = pending_read("terminal-out");
        let (err_read, err_writer, err_pending) = pending_read("terminal-err");
        let mut kernel = budget_kernel();
        kernel.bound_at = Some(Instant::now() - Duration::from_millis(4800));
        kernel.first_terminal_at = None;
        let mut io = empty_io();
        io.stdout = Some(out_pending);
        io.stderr = Some(err_pending);
        kernel.io = Some(io);
        drop(out_writer);
        assert!(matches!(
            kernel.transfer_output(StreamKind::Stdout),
            KernelReply::Eof { .. }
        ));
        let observed_terminal = kernel
            .first_terminal_at
            .expect("actual stdout EOF must set terminal origin");
        // Advance both real monotonic origins equally, preserving the actual
        // stdout EOF relation. Terminal+grace has expired; work D has not.
        kernel.bound_at = Some(kernel.bound_at.unwrap() - Duration::from_millis(5100));
        kernel.first_terminal_at = Some(observed_terminal - Duration::from_millis(5100));
        assert!(
            kernel.bound_at.unwrap().elapsed() < Duration::from_millis(10000),
            "fixture work deadline must still be future"
        );
        assert!(
            kernel.first_terminal_at.unwrap().elapsed() > Duration::from_millis(DRAIN_GRACE_MS)
        );
        let before = Instant::now();
        let reply = kernel.transfer_output(StreamKind::Stderr);
        let elapsed = before.elapsed();
        // Separately bounded teardown, never evidence that expired cleanup succeeded.
        kernel.cancel_outstanding_io().unwrap();
        kernel.bound_at = Some(Instant::now());
        kernel.first_terminal_at = None;
        kernel.retire_io().unwrap();
        assert!(kernel.io.as_ref().unwrap().retired);
        drop((out_read, err_read, err_writer));
        assert_eq!(reply, KernelReply::DeadlineReached);
        assert!(
            elapsed < Duration::from_millis(50),
            "early terminal bound was renewed: {elapsed:?}"
        );
        println!(
            "NATIVE_EARLY_TERMINAL_PASS actual_stdout_eof=true actual_pending_stderr=true elapsed_us={}",
            elapsed.as_micros()
        );
    }

    pub fn normal_output_does_not_spend_cleanup_grace() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let (read, writer) = native_pipe_pair(
            &format!(
                r"\\.\pipe\DecadansOfflineDeadlineG5-{}-{nonce}",
                std::process::id()
            ),
            true,
            TypedHandleKind::StdoutRead,
            TypedHandleKind::StdoutWrite,
        )
        .unwrap();
        let mut pending =
            NativePendingIo::prepared(read.raw(), NativeIoDirection::Read, vec![0; 32]).unwrap();
        pending.submit().unwrap();
        assert_eq!(pending.state, NativeOperationState::Pending);
        let mut kernel = RealWin32Kernel::default();
        let mut context = native_privilege_boundary_tests::context();
        context.envelope.deadline_ms = 50;
        kernel.context = Some(context);
        // Operational deadline expired long ago; 150 ms of cleanup remains.
        kernel.bound_at = Some(Instant::now() - Duration::from_millis(DRAIN_GRACE_MS - 100));
        kernel.io = Some(NativeIoBundle {
            stdin: None,
            stdout: Some(pending),
            stderr: None,
            stdout_bytes: vec![],
            stderr_bytes: vec![],
            stdin_state: PipeState::Uninitialized,
            stdout_state: PipeState::Open,
            stderr_state: PipeState::Uninitialized,
            stdout_eof: false,
            stdout_cap_exceeded: false,
            stderr_eof: false,
            stderr_nonzero_seen: false,
            retired: false,
        });
        let before = Instant::now();
        let reply = kernel.transfer_output(StreamKind::Stdout);
        let elapsed = before.elapsed();
        kernel.cancel_outstanding_io().unwrap();
        kernel.retire_io().unwrap();
        assert!(kernel.io.as_ref().unwrap().retired);
        drop((read, writer));
        assert_eq!(reply, KernelReply::DeadlineReached);
        assert!(
            elapsed < Duration::from_millis(100),
            "normal output consumed cleanup reserve: {elapsed:?}"
        );
        println!(
            "NATIVE_OUTPUT_DEADLINE_PASS actual_pending_pipe=true elapsed_us={}",
            elapsed.as_micros()
        );
    }

    pub fn physical_eof_after_actual_transfer() {
        let payload = b"P-G5 actual native stdin completion must deliver physical EOF\n".to_vec();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let name = format!(
            r"\\.\pipe\DecadansOfflineStdinG5-{}-{nonce}",
            std::process::id()
        );
        let (writer, reader) = native_pipe_pair(
            &name,
            false,
            TypedHandleKind::StdinWrite,
            TypedHandleKind::StdinRead,
        )
        .unwrap();
        let (out_read, out_write) = native_pipe_pair(
            &format!("{name}-out"),
            true,
            TypedHandleKind::StdoutRead,
            TypedHandleKind::StdoutWrite,
        )
        .unwrap();
        let (err_read, err_write) = native_pipe_pair(
            &format!("{name}-err"),
            true,
            TypedHandleKind::StderrRead,
            TypedHandleKind::StderrWrite,
        )
        .unwrap();
        let reader = ManuallyDrop::new(reader);
        let file = unsafe { File::from_raw_handle(reader.raw()) };
        let (done_tx, done_rx) = mpsc::channel();
        let reader_thread = thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = file
                .take((MAX_HANDOFF_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
                .map(|_| bytes);
            let _ = done_tx.send(result);
        });
        let mut write =
            NativePendingIo::prepared(writer.raw(), NativeIoDirection::Write, payload.clone())
                .unwrap();
        write.submit().unwrap();
        let mut context = native_privilege_boundary_tests::context();
        context.envelope.deadline_ms = 1000;
        let mut kernel = RealWin32Kernel::default();
        // Assign fixture-only timeout data; never bind_context or invoke effect capabilities.
        kernel.context = Some(context);
        kernel.bound_at = Some(Instant::now());
        kernel.pipes = Some(NativePipeHandles {
            parent_stdin_write: Some(writer),
            parent_stdout_read: out_read,
            parent_stderr_read: err_read,
            child_stdin_read: None,
            child_stdout_write: Some(out_write),
            child_stderr_write: Some(err_write),
        });
        kernel.io = Some(NativeIoBundle {
            stdin: Some(write),
            stdout: None,
            stderr: None,
            stdout_bytes: vec![],
            stderr_bytes: vec![],
            stdin_state: PipeState::Open,
            stdout_state: PipeState::Uninitialized,
            stderr_state: PipeState::Uninitialized,
            stdout_eof: false,
            stdout_cap_exceeded: false,
            stderr_eof: false,
            stderr_nonzero_seen: false,
            retired: false,
        });
        let result = kernel.transfer_stdin();
        let observed = done_rx.recv_timeout(Duration::from_millis(250));
        let physical_eof_before_cleanup = observed.is_ok();
        // Always consume finite RED cleanup too; assertion cannot strand a reader.
        kernel.cancel_outstanding_io().unwrap();
        kernel.retire_io().unwrap();
        assert!(kernel.io.as_ref().unwrap().retired);
        drop(kernel.pipes.take());
        let bytes = match observed {
            Ok(value) => value.unwrap(),
            Err(_) => done_rx
                .recv_timeout(Duration::from_millis(1000))
                .unwrap()
                .unwrap(),
        };
        reader_thread.join().unwrap();
        assert_eq!(bytes, payload);
        assert!(matches!(result, KernelReply::TransferComplete{bytes} if bytes == payload.len()));
        assert!(
            physical_eof_before_cleanup,
            "full terminal native stdin write must produce real reader EOF before cleanup"
        );
        println!(
            "NATIVE_STDIN_EOF_PASS physical_eof_before_cleanup=true cancel_retire_connected=true"
        );
    }
}

#[cfg(all(windows, test))]
mod native_privilege_boundary_tests {
    use super::*;

    pub(super) fn context() -> ProductionInvocationContext {
        let payload = serde_json::to_vec(&serde_json::json!({
            "consumer":OBSERVER_REQUEST_CONSUMER,"operation":"read-bound-file","requestId":"request-1",
            "rootPath":r"\\?\C:\ProgramData\DecadansNeurobro\accepted-evidence-v1",
            "schema":OBSERVER_REQUEST_SCHEMA,"targetPath":r"requests\request-1.json","version":"v1"
        })).unwrap();
        let envelope = WireEnvelope {
            schema: REQUEST_SCHEMA.into(),
            version: "v1".into(),
            request_id: "request-1".into(),
            correlation_id: "correlation-1".into(),
            carrier_sha256: "a".repeat(64),
            launcher_image_path: LAUNCHER_IMAGE_DOS.into(),
            launcher_image_sha256: "c".repeat(64),
            observer_image_path: OBSERVER_IMAGE_DOS.into(),
            observer_image_sha256: "b".repeat(64),
            evidence_root_absolute_path: ACCEPTED_EVIDENCE_ROOT_DOS.into(),
            stdin_sha256: sha256_hex(&payload),
            stdin_byte_count: payload.len() as u64,
            deadline_ms: 10_000,
        };
        let header = serde_json::to_vec(&envelope).unwrap();
        ProductionInvocationContext::new_supervisor(envelope, header, payload).unwrap()
    }
    #[test]
    fn actual_acquire_restore_unknown_reaches_main_without_effects() {
        use super::native_launcher_privilege::{
            fixture_disable_quota, fixture_fail_acquire_and_restore_readback,
            fixture_privilege_snapshot,
        };
        const KEY: &str = "RM0032_NATIVE_MAIN_PRIVILEGE_FIXTURE_CHILD";
        if std::env::var_os(KEY).is_none() {
            let before = fixture_privilege_snapshot();
            let module = module_path!().split_once("::").unwrap().1;
            let selector =
                format!("{module}::actual_acquire_restore_unknown_reaches_main_without_effects");
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", &selector, "--nocapture", "--test-threads=1"])
                .env(KEY, "child")
                .output()
                .unwrap();
            assert_eq!(fixture_privilege_snapshot(), before);
            assert!(
                output.status.success(),
                "main fixture {} {}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(
                String::from_utf8_lossy(&output.stdout)
                    .contains("NATIVE_MAIN_PRIVILEGE_UNKNOWN_PASS")
            );
            return;
        }
        assert_eq!(std::env::var(KEY).unwrap(), "child");
        fixture_disable_quota();
        assert!(!native_launcher_privilege::fixture_security_enabled());
        let before = fixture_privilege_snapshot();
        let supervisor = context();
        let worker = parse_production_input(
            Mode::Worker,
            &supervisor.supervisor_handoff_bytes().unwrap(),
        )
        .unwrap();
        for context in [supervisor, worker] {
            fixture_fail_acquire_and_restore_readback();
            let mut kernel = RealWin32Kernel::default();
            let result = run_and_close(&context, &mut kernel);
            assert_eq!(result.terminal, ReducerTerminal::Unknown);
            assert!(result.sticky);
            assert_eq!(
                result.child_start_evidence,
                ChildStartEvidence::NeverStarted
            );
            assert!(
                kernel.calls.is_empty(),
                "no native step capability before quota UNKNOWN"
            );
            assert_eq!(fixture_privilege_snapshot(), before);
            let calls = native_ledger_security::fixture_create_call_count();
            fixture_fail_acquire_and_restore_readback();
            assert!(matches!(
                native_create_ledger(&context),
                Err(KernelReply::Unknown(_))
            ));
            assert_eq!(
                native_ledger_security::fixture_create_call_count(),
                calls,
                "ledger acquisition UNKNOWN never reaches real CREATE_NEW"
            );
            assert_eq!(fixture_privilege_snapshot(), before);
        }
        println!("NATIVE_MAIN_PRIVILEGE_UNKNOWN_PASS");
    }
}

#[cfg(all(windows, test))]
pub(crate) mod native_snapshot_fixture {
    use super::*;
    use std::os::windows::fs::MetadataExt;
    use std::path::Path;
    use windows_sys::Win32::Foundation::{ERROR_ALREADY_EXISTS, FILETIME, GENERIC_WRITE};
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CREATE_NEW, CreateDirectoryW, FILE_ATTRIBUTE_READONLY, FILE_WRITE_ATTRIBUTES, SetFileTime,
    };

    const FIXTURE_ROOT: &str =
        r"C:\Neurobro\scratch\phase3-access-time-g4-20260905";

    fn fixture_security() -> OwnedLocalAllocation {
        let mut descriptor = null_mut();
        assert_ne!(
            unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    wide("O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)").as_ptr(),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    null_mut(),
                )
            },
            0
        );
        OwnedLocalAllocation(descriptor)
    }

    fn fixture_directory(
        path: &Path,
        descriptor: &OwnedLocalAllocation,
        allow_owned_root: bool,
    ) -> OwnedNativeHandle {
        assert!(path.starts_with(FIXTURE_ROOT));
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: 0,
        };
        let result =
            unsafe { CreateDirectoryW(wide(path.to_str().unwrap()).as_ptr(), &attributes) };
        if result == 0 {
            let error = unsafe { GetLastError() };
            assert!(
                allow_owned_root
                    && path == Path::new(FIXTURE_ROOT)
                    && error == ERROR_ALREADY_EXISTS,
                "new fixture directory refused: {error}"
            );
        }
        let metadata = std::fs::symlink_metadata(path).unwrap();
        assert!(metadata.is_dir());
        assert_eq!(metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT, 0);
        // Validate existing root read-only on later aggregate runs. Never repair
        // security on an existing object, and never create/modify any ancestor.
        let handle = pin_fixture_directory(path);
        query_native_security(handle.raw(), false, false)
            .expect("fixture directory protected native security");
        handle
    }

    fn pin_fixture_directory(path: &Path) -> OwnedNativeHandle {
        let handle = OwnedNativeHandle::new(
            unsafe {
                CreateFileW(
                    wide(path.to_str().unwrap()).as_ptr(),
                    FILE_READ_ATTRIBUTES | READ_CONTROL,
                    FILE_SHARE_READ,
                    null(),
                    OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                    null_mut(),
                )
            },
            TypedHandleKind::HeldAncestor,
        )
        .expect("readonly no-delete fixture namespace pin");
        assert_eq!(
            native_final_path(handle.raw()).unwrap(),
            format!(r"\\?\{}", path.display())
        );
        let basic: FILE_BASIC_INFO = native_file_info(handle.raw(), FileBasicInfo).unwrap();
        assert_eq!(basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT, 0);
        handle
    }

    fn write_fixture_file(
        path: &Path,
        bytes: &[u8],
        descriptor: &OwnedLocalAllocation,
        seed_access_time: bool,
    ) {
        assert!(path.starts_with(FIXTURE_ROOT));
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: 0,
        };
        let handle = OwnedNativeHandle::new(
            unsafe {
                CreateFileW(
                    wide(path.to_str().unwrap()).as_ptr(),
                    GENERIC_WRITE | FILE_WRITE_ATTRIBUTES | FILE_READ_ATTRIBUTES | READ_CONTROL,
                    0,
                    &attributes,
                    CREATE_NEW,
                    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
                    null_mut(),
                )
            },
            TypedHandleKind::HeldImage,
        )
        .expect("new fixture file only");
        let mut written = 0;
        assert_ne!(
            unsafe {
                WriteFile(
                    handle.raw(),
                    bytes.as_ptr(),
                    bytes.len() as u32,
                    &mut written,
                    null_mut(),
                )
            },
            0
        );
        assert_eq!(written as usize, bytes.len());
        assert_ne!(unsafe { FlushFileBuffers(handle.raw()) }, 0);
        if seed_access_time {
            // Deterministic metadata only on this newly created owned file.
            let ticks = 134330778904255280u64;
            let access = FILETIME {
                dwLowDateTime: ticks as u32,
                dwHighDateTime: (ticks >> 32) as u32,
            };
            assert_ne!(
                unsafe { SetFileTime(handle.raw(), null(), &access, null()) },
                0
            );
        }
    }

    fn observation(snapshot: &NativeFileSnapshot) -> serde_json::Value {
        serde_json::json!({
            "finalPath":snapshot.final_path,"volumeSerial":snapshot.volume_serial.to_string(),
            "fileId":snapshot.file_id,"size":snapshot.size.to_string(),"linkCount":snapshot.link_count,
            "attributes":snapshot.attributes,"creationTime":snapshot.creation_time.to_string(),
            "lastAccessTime":snapshot.last_access_time.to_string(),"lastWriteTime":snapshot.last_write_time.to_string(),
            "changeTime":snapshot.change_time.to_string(),"sha256":snapshot.sha256,
            "security":{"ownerSid":snapshot.security.owner_sid,"daclAceCount":snapshot.security.dacl_ace_count,
                "lowIntegrityNoWriteUp":snapshot.security.low_integrity_no_write_up,
                "packageDirectoryAce":snapshot.security.package_directory_ace,
                "packageLeafAce":snapshot.security.package_leaf_ace,
                "ledgerDescriptorBytes":snapshot.security.ledger_descriptor_bytes}
        })
    }

    pub fn observe_actual_file() {
        let root = Path::new(FIXTURE_ROOT);
        // Existing ancestors must already exist and be non-reparse; their
        // creation/ACLs are not delegated to this fixture helper.
        let mut namespace_pins = Vec::new();
        for ancestor in root.parent().unwrap().ancestors() {
            let metadata =
                std::fs::symlink_metadata(ancestor).expect("fixture namespace pre-exists");
            assert!(metadata.is_dir());
            assert_eq!(metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT, 0);
            namespace_pins.push(pin_fixture_directory(ancestor));
        }
        let descriptor = fixture_security();
        namespace_pins.push(fixture_directory(root, &descriptor, true));
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = root.join(format!("snapshot-{}-{stamp}", std::process::id()));
        namespace_pins.push(fixture_directory(&directory, &descriptor, false));
        let path = directory.join("benign.bin");
        write_fixture_file(
            &path,
            b"P-G4 benign native snapshot fixture\n",
            &descriptor,
            true,
        );
        let final_path = format!(r"\\?\{}", path.display());
        let mut report = serde_json::json!({"productExecution":false,"profileMutation":false});
        let result = (|| -> Result<(), &'static str> {
            let held = open_native_file(&final_path, false, false, TypedHandleKind::HeldImage)?;
            report["before"] = observation(&held.snapshot);
            let current = native_file_snapshot(
                held.handle.raw(),
                &final_path,
                false,
                false,
                TypedHandleKind::HeldImage,
            )?;
            report["after"] = observation(&current);
            let reopened = open_native_file(&final_path, false, false, TypedHandleKind::HeldImage)?;
            report["reopened"] = observation(&reopened.snapshot);
            report["sameHandleStable"] = held.snapshot.stable_integrity_matches(&current).into();
            report["reopenedStable"] = held
                .snapshot
                .stable_integrity_matches(&reopened.snapshot)
                .into();
            report["rawEquality"] = (held.snapshot == current).into();
            report["reopenedRawEquality"] = (held.snapshot == reopened.snapshot).into();
            Ok(())
        })();
        if let Err(reason) = &result {
            report["error"] = (*reason).into();
        }
        let evidence_path = directory.join("observation.json");
        write_fixture_file(
            &evidence_path,
            &serde_json::to_vec_pretty(&report).unwrap(),
            &descriptor,
            false,
        );
        println!(
            "NATIVE_SNAPSHOT_FIXTURE_EVIDENCE={} {}",
            evidence_path.display(),
            report
        );
        // Evidence is retained before deciding the observation's success.
        result.expect("actual production file snapshot observation");
        assert_eq!(report["sameHandleStable"], true);
        assert_eq!(report["reopenedStable"], true);
        println!("NATIVE_SNAPSHOT_FIXTURE_PASS");
    }

    pub fn assert_integrity_contract() {
        // Only the access-time pairs are replayed from the retained G3 native
        // read-only probe. Other members are explicit synthetic contract data.
        let baseline = NativeFileSnapshot {
            final_path: r"\\?\C:\fixture\benign.bin".into(),
            volume_serial: 1,
            file_id: [2; 16],
            size: 3,
            link_count: 1,
            attributes: FILE_ATTRIBUTE_NORMAL,
            creation_time: 4,
            last_access_time: 134330778904255280,
            last_write_time: 5,
            change_time: 6,
            sha256: "a".repeat(64),
            security: NativeSecuritySnapshot {
                owner_sid: "S-1-5-32-544".into(),
                dacl_ace_count: 2,
                low_integrity_no_write_up: true,
                package_directory_ace: false,
                package_leaf_ace: false,
                ledger_descriptor_bytes: Some(vec![1, 2, 3]),
            },
        };
        assert!(baseline.stable_integrity_matches(&baseline));
        for (before, after) in [
            (134330778904255280, 134330789031299521),
            (134330778904293215, 134330789031346440),
        ] {
            let mut first = baseline.clone();
            first.last_access_time = before;
            let mut second = first.clone();
            second.last_access_time = after;
            assert_ne!(
                first, second,
                "replayed actual atime values must change input"
            );
            assert!(
                first.stable_integrity_matches(&second),
                "read-induced access-time observation must not reject stable integrity"
            );
            assert!(second.stable_integrity_matches(&first));
            assert_eq!(
                (first.last_access_time, second.last_access_time),
                (before, after),
                "comparison must not erase retained observations"
            );
        }
        type Mutation = (&'static str, fn(&mut NativeFileSnapshot));
        let mutations: [Mutation; 16] = [
            ("final_path", |s| s.final_path.push('x')),
            ("volume_serial", |s| s.volume_serial += 1),
            ("file_id", |s| s.file_id[0] ^= 1),
            ("size", |s| s.size += 1),
            ("link_count", |s| s.link_count += 1),
            ("attributes", |s| s.attributes ^= FILE_ATTRIBUTE_READONLY),
            ("creation_time", |s| s.creation_time += 1),
            ("last_write_time", |s| s.last_write_time += 1),
            ("change_time", |s| s.change_time += 1),
            ("sha256", |s| s.sha256 = "b".repeat(64)),
            ("security.owner_sid", |s| {
                s.security.owner_sid = "S-1-5-18".into()
            }),
            ("security.dacl_ace_count", |s| {
                s.security.dacl_ace_count += 1
            }),
            ("security.low_integrity_no_write_up", |s| {
                s.security.low_integrity_no_write_up = false
            }),
            ("security.package_directory_ace", |s| {
                s.security.package_directory_ace = true
            }),
            ("security.package_leaf_ace", |s| {
                s.security.package_leaf_ace = true
            }),
            ("security.ledger_descriptor_bytes", |s| {
                s.security.ledger_descriptor_bytes.as_mut().unwrap()[0] ^= 1
            }),
        ];
        for (field, mutate) in mutations {
            let mut changed = baseline.clone();
            mutate(&mut changed);
            assert_ne!(baseline, changed, "hostile input is connected: {field}");
            assert!(
                !baseline.stable_integrity_matches(&changed),
                "stable field: {field}"
            );
            assert!(
                !changed.stable_integrity_matches(&baseline),
                "reverse: {field}"
            );
            changed.last_access_time = 134330789031299521;
            assert!(
                !baseline.stable_integrity_matches(&changed),
                "mixed atime + {field}"
            );
            assert!(
                !changed.stable_integrity_matches(&baseline),
                "mixed reverse: {field}"
            );
        }
        let mut missing_descriptor = baseline.clone();
        missing_descriptor.security.ledger_descriptor_bytes = None;
        assert!(!baseline.stable_integrity_matches(&missing_descriptor));
        missing_descriptor.last_access_time += 1;
        assert!(!baseline.stable_integrity_matches(&missing_descriptor));
        println!(
            "NATIVE_SNAPSHOT_INTEGRITY_PASS actual_atime_pairs=2 stable_fields=16 mixed_fields=16 descriptor_absence=2"
        );
    }
}

pub fn parse_then_run_with_kernel_factory<K, F>(
    mode: Mode,
    bytes: &[u8],
    kernel_factory: F,
) -> Result<(LauncherResult, K), &'static str>
where
    K: LauncherKernel,
    F: FnOnce() -> K,
{
    // The canonical wire envelope is the final stdin trust boundary.  Keep the
    // factory behind it so a refused deadline cannot create a ledger, child,
    // wait handle, or any other kernel-owned effect.
    let context = parse_production_input(mode, bytes)?;
    let mut kernel = kernel_factory();
    let result = run_and_close(&context, &mut kernel);
    Ok((result, kernel))
}

fn main() {
    let arguments: Vec<String> = env::args().collect();
    let mode = parse_mode(&arguments).unwrap_or_else(|_| std::process::exit(64));
    let mut bytes = Vec::new();
    if std::io::stdin()
        .take((MAX_HANDOFF_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .is_err()
    {
        std::process::exit(65);
    }
    let (result, _) = parse_then_run_with_kernel_factory(mode, &bytes, RealWin32Kernel::default)
        .unwrap_or_else(|_| std::process::exit(65));
    let output = serde_json::to_vec(&result).unwrap_or_else(|_| std::process::exit(70));
    if std::io::stdout().write_all(&output).is_err() {
        std::process::exit(74);
    }
}
