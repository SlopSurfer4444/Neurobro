//! Ledger-only security: no AppContainer profile or token-policy dependency.
//! A successful CREATE_NEW consumes the attempt even when subsequent proof fails.
//! This module never deletes a ledger, retries creation, or repairs an existing ACL.
#![cfg(windows)]

use std::ffi::c_void;
use std::fs::File;
use std::mem::{size_of, zeroed};
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{
    ERROR_ALREADY_EXISTS, ERROR_FILE_EXISTS, ERROR_SUCCESS, GENERIC_READ, GENERIC_WRITE,
    GetHandleInformation, GetLastError, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
    LocalFree,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo,
    SDDL_REVISION_1, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_SIZE_INFORMATION, AclSizeInformation,
    DACL_SECURITY_INFORMATION, GetAce, GetAclInformation, GetLengthSid,
    GetSecurityDescriptorControl, GetSecurityDescriptorLength, IsValidAcl,
    IsValidSecurityDescriptor, IsValidSid, LABEL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
    PSID, SE_DACL_PROTECTED, SE_SACL_PROTECTED, SE_SELF_RELATIVE, SECURITY_ATTRIBUTES,
};
use windows_sys::Win32::Storage::FileSystem::{
    CREATE_NEW, CreateFileW, FILE_ALL_ACCESS, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_BASIC_INFO, FILE_BEGIN, FILE_FLAG_OPEN_REPARSE_POINT, FILE_FLAG_WRITE_THROUGH,
    FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_STANDARD_INFO, FileBasicInfo, FileStandardInfo,
    FlushFileBuffers, GetFileInformationByHandleEx, OPEN_EXISTING, READ_CONTROL, ReadFile,
    SetFilePointerEx, WriteFile,
};
use windows_sys::Win32::System::SystemServices::{
    ACCESS_ALLOWED_ACE_TYPE, SYSTEM_MANDATORY_LABEL_ACE_TYPE, SYSTEM_MANDATORY_LABEL_NO_WRITE_UP,
};

pub const INITIAL_LEDGER_SDDL: &str = "O:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)S:P(ML;;NW;;;LW)";
#[cfg(test)]
pub(crate) fn fixture_create_call_count() -> usize {
    tests::create_calls()
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LedgerSecuritySnapshot {
    pub owner_sid: String,
    pub dacl_ace_count: u32,
    pub low_integrity_no_write_up: bool,
    /// Exact self-relative OWNER + DACL + LABEL query bytes, not merely an ACE count.
    pub descriptor_bytes: Vec<u8>,
}

#[derive(Debug, Eq, PartialEq)]
pub enum LedgerCreateError {
    BeforeCreate(&'static str),
    Collision,
    CreateFailed(u32),
    /// A valid creation handle existed. The file remains; no retry is permissible.
    AfterCreate(&'static str),
    /// Creation did not return a handle, but privilege restoration was uncertain.
    PrivilegeRestoration(&'static str),
}

struct LocalAllocation(*mut c_void);

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { LocalFree(self.0) };
        }
    }
}

fn wide(value: &str) -> Result<Vec<u16>, &'static str> {
    if value.is_empty() || value.contains('\0') {
        return Err("ledger path or descriptor is empty or contains NUL");
    }
    Ok(value.encode_utf16().chain(std::iter::once(0)).collect())
}

fn descriptor_from_sddl(sddl: &str) -> Result<LocalAllocation, &'static str> {
    let text = wide(sddl)?;
    let mut raw = null_mut();
    let result = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            text.as_ptr(),
            SDDL_REVISION_1,
            &mut raw,
            null_mut(),
        )
    };
    let allocation = LocalAllocation(raw);
    if result == 0 || allocation.0.is_null() {
        return Err("ledger initial security descriptor conversion failed");
    }
    Ok(allocation)
}

fn sid_string(sid: PSID) -> Result<String, &'static str> {
    if sid.is_null() || unsafe { IsValidSid(sid) } == 0 {
        return Err("ledger security SID is invalid");
    }
    let mut raw = null_mut();
    let result = unsafe { ConvertSidToStringSidW(sid, &mut raw) };
    let allocation = LocalAllocation(raw.cast());
    if result == 0 || allocation.0.is_null() {
        return Err("ledger security SID conversion failed");
    }
    let mut length = 0usize;
    while length < 256 && unsafe { *raw.add(length) } != 0 {
        length += 1;
    }
    if length == 256 {
        return Err("ledger security SID text is oversized");
    }
    String::from_utf16(unsafe { std::slice::from_raw_parts(raw, length) })
        .map_err(|_| "ledger security SID text is invalid UTF-16")
}

fn acl_count(acl: *mut ACL) -> Result<u32, &'static str> {
    if acl.is_null() || unsafe { IsValidAcl(acl) } == 0 {
        return Err("ledger security ACL is absent or invalid");
    }
    let mut info: ACL_SIZE_INFORMATION = unsafe { zeroed() };
    if unsafe {
        GetAclInformation(
            acl,
            (&mut info as *mut ACL_SIZE_INFORMATION).cast(),
            size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    } == 0
    {
        return Err("ledger security ACL size query failed");
    }
    Ok(info.AceCount)
}

fn verify_ace(
    acl: *mut ACL,
    index: u32,
    ace_type: u32,
    mask: u32,
    expected_sid: &str,
) -> Result<(), &'static str> {
    let mut raw = null_mut();
    if unsafe { GetAce(acl, index, &mut raw) } == 0 || raw.is_null() {
        return Err("ledger security ACE query failed");
    }
    let header = unsafe { &*raw.cast::<ACE_HEADER>() };
    if u32::from(header.AceType) != ace_type
        || header.AceFlags != 0
        || usize::from(header.AceSize) < size_of::<ACCESS_ALLOWED_ACE>() + 4
    {
        return Err("ledger security ACE type, flags or size differs");
    }
    // Allowed and mandatory-label ACEs share header/mask/SidStart layout.
    let ace = unsafe { &*raw.cast::<ACCESS_ALLOWED_ACE>() };
    let sid = (&ace.SidStart as *const u32).cast_mut().cast::<c_void>();
    let sid_bytes_available = usize::from(header.AceSize) - 8;
    let sid_subauthorities = unsafe { *sid.cast::<u8>().add(1) } as usize;
    if sid_bytes_available != 8 + sid_subauthorities * 4
        || unsafe { IsValidSid(sid) } == 0
        || unsafe { GetLengthSid(sid) } as usize != sid_bytes_available
        || ace.Mask != mask
        || sid_string(sid)? != expected_sid
    {
        return Err("ledger security ACE mask or exact SID differs");
    }
    Ok(())
}

/// Require the exact initial ledger policy using only mandatory-label information.
/// LABEL_SECURITY_INFORMATION avoids the SeSecurityPrivilege needed for an arbitrary SACL query.
pub fn query_ledger_security(handle: HANDLE) -> Result<LedgerSecuritySnapshot, &'static str> {
    let mut owner = null_mut();
    let mut dacl = null_mut();
    let mut label = null_mut();
    let mut raw = null_mut();
    let status = unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            &mut label,
            &mut raw,
        )
    };
    let descriptor = LocalAllocation(raw);
    if status != ERROR_SUCCESS
        || descriptor.0.is_null()
        || unsafe { IsValidSecurityDescriptor(descriptor.0) } == 0
    {
        return Err("ledger owner/DACL/label query failed");
    }
    let mut control = 0u16;
    let mut revision = 0u32;
    let required = SE_SELF_RELATIVE | SE_DACL_PROTECTED | SE_SACL_PROTECTED;
    if unsafe { GetSecurityDescriptorControl(descriptor.0, &mut control, &mut revision) } == 0
        || control & required != required
    {
        return Err("ledger descriptor is not self-relative with protected DACL and label");
    }
    let owner_sid = sid_string(owner)?;
    if owner_sid != "S-1-5-32-544" {
        return Err("ledger owner is not exactly Builtin Administrators");
    }
    let dacl_ace_count = acl_count(dacl)?;
    if dacl_ace_count != 2 || acl_count(label)? != 1 {
        return Err("ledger DACL or mandatory-label ACE count differs");
    }
    verify_ace(
        dacl,
        0,
        ACCESS_ALLOWED_ACE_TYPE,
        FILE_ALL_ACCESS,
        "S-1-5-18",
    )?;
    verify_ace(
        dacl,
        1,
        ACCESS_ALLOWED_ACE_TYPE,
        FILE_ALL_ACCESS,
        "S-1-5-32-544",
    )?;
    verify_ace(
        label,
        0,
        SYSTEM_MANDATORY_LABEL_ACE_TYPE,
        SYSTEM_MANDATORY_LABEL_NO_WRITE_UP,
        "S-1-16-4096",
    )?;
    let length = unsafe { GetSecurityDescriptorLength(descriptor.0) } as usize;
    if !(20..=65_536).contains(&length) {
        return Err("ledger security descriptor length is invalid");
    }
    let descriptor_bytes =
        unsafe { std::slice::from_raw_parts(descriptor.0.cast::<u8>(), length) }.to_vec();
    Ok(LedgerSecuritySnapshot {
        owner_sid,
        dacl_ace_count,
        low_integrity_no_write_up: true,
        descriptor_bytes,
    })
}

fn verify_file_handle(handle: HANDLE, empty: bool) -> Result<(), &'static str> {
    let mut flags = 0u32;
    if unsafe { GetHandleInformation(handle, &mut flags) } == 0 || flags & HANDLE_FLAG_INHERIT != 0
    {
        return Err("ledger handle is inheritable or inheritance proof failed");
    }
    let mut standard: FILE_STANDARD_INFO = unsafe { zeroed() };
    let mut basic: FILE_BASIC_INFO = unsafe { zeroed() };
    if unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileStandardInfo,
            (&mut standard as *mut FILE_STANDARD_INFO).cast(),
            size_of::<FILE_STANDARD_INFO>() as u32,
        )
    } == 0
        || unsafe {
            GetFileInformationByHandleEx(
                handle,
                FileBasicInfo,
                (&mut basic as *mut FILE_BASIC_INFO).cast(),
                size_of::<FILE_BASIC_INFO>() as u32,
            )
        } == 0
    {
        return Err("ledger file metadata query failed");
    }
    if standard.Directory
        || standard.DeletePending
        || standard.NumberOfLinks != 1
        || basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (empty && standard.EndOfFile != 0)
    {
        return Err("ledger is not a regular single-link file in the required state");
    }
    Ok(())
}

fn readback(handle: HANDLE, expected: &[u8]) -> Result<(), &'static str> {
    if unsafe { SetFilePointerEx(handle, 0, null_mut(), FILE_BEGIN) } == 0 {
        return Err("ledger readback rewind failed");
    }
    let mut buffer = [0u8; 4096];
    let mut offset = 0usize;
    while offset < expected.len() {
        let requested = buffer.len().min(expected.len() - offset);
        let mut read = 0u32;
        if unsafe {
            ReadFile(
                handle,
                buffer.as_mut_ptr(),
                requested as u32,
                &mut read,
                null_mut(),
            )
        } == 0
            || read == 0
            || read as usize > requested
        {
            return Err("ledger same-handle readback failed or made invalid progress");
        }
        let count = read as usize;
        if buffer[..count] != expected[offset..offset + count] {
            return Err("ledger same-handle readback bytes differ");
        }
        offset += count;
    }
    let mut read = 0u32;
    if unsafe { ReadFile(handle, buffer.as_mut_ptr(), 1, &mut read, null_mut()) } == 0 || read != 0
    {
        return Err("ledger same-handle readback did not end at exact EOF");
    }
    Ok(())
}

fn create_initial_handle(
    path: &str,
    descriptor: LocalAllocation,
) -> Result<File, LedgerCreateError> {
    #[cfg(test)]
    tests::test_create_boundary(path);
    let path_wide = wide(path).map_err(LedgerCreateError::BeforeCreate)?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    // The LocalAllocation is alive through CreateFileW; no post-create ACL window exists.
    let raw = unsafe {
        CreateFileW(
            path_wide.as_ptr(),
            GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
            FILE_SHARE_READ,
            &attributes,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH,
            null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        let error = unsafe { GetLastError() }; // Capture before any other Win32 call or drop.
        return Err(
            if matches!(error, ERROR_FILE_EXISTS | ERROR_ALREADY_EXISTS) {
                LedgerCreateError::Collision
            } else {
                LedgerCreateError::CreateFailed(error)
            },
        );
    }
    if raw.is_null() {
        return Err(LedgerCreateError::AfterCreate(
            "ledger creation returned an ambiguous null handle",
        ));
    }
    let file = unsafe { File::from_raw_handle(raw) };
    #[cfg(test)]
    if tests::inject_created_unknown() {
        return Err(LedgerCreateError::AfterCreate(
            "injected outcome ambiguity after real CREATE_NEW",
        ));
    }
    Ok(file)
}

fn create_with_descriptor(
    path: &str,
    record: &[u8],
    descriptor: LocalAllocation,
    before_write: impl FnOnce(&File, &LedgerSecuritySnapshot) -> Result<(), &'static str>,
) -> Result<File, LedgerCreateError> {
    let length = u32::try_from(record.len())
        .map_err(|_| LedgerCreateError::BeforeCreate("ledger record exceeds WriteFile range"))?;
    if length == 0 {
        return Err(LedgerCreateError::BeforeCreate("ledger record is empty"));
    }
    let mut privilege = super::native_launcher_privilege::ScopedLedgerSaclPrivilege::acquire()
        .map_err(|error| match error {
            super::native_launcher_privilege::AcquireError::Refused(_) => {
                LedgerCreateError::BeforeCreate("ledger initial-SACL privilege unavailable")
            }
            super::native_launcher_privilege::AcquireError::RestorationUnknown(_) => {
                LedgerCreateError::PrivilegeRestoration(
                    "ledger acquire failed and initial-SACL privilege restoration unverified",
                )
            }
        })?;
    let created = create_initial_handle(path, descriptor);
    // Preserve the immediate CREATE_NEW outcome, then restore BEFORE any
    // security callback, record write, flush, or downstream spawn capability.
    if privilege.restore_verified().is_err() {
        return Err(
            if created.is_ok() || matches!(created, Err(LedgerCreateError::AfterCreate(_))) {
                LedgerCreateError::AfterCreate(
                    "ledger created but SACL privilege restoration unverified",
                )
            } else {
                LedgerCreateError::PrivilegeRestoration(
                    "ledger SACL privilege restoration unverified after failed create",
                )
            },
        );
    }
    drop(privilege);
    let file = created?;
    let raw = file.as_raw_handle();
    let security = query_ledger_security(raw).map_err(LedgerCreateError::AfterCreate)?;
    verify_file_handle(raw, true).map_err(LedgerCreateError::AfterCreate)?;
    before_write(&file, &security).map_err(LedgerCreateError::AfterCreate)?;
    let mut written = 0u32;
    if unsafe { WriteFile(raw, record.as_ptr(), length, &mut written, null_mut()) } == 0
        || written != length
    {
        return Err(LedgerCreateError::AfterCreate(
            "ledger WriteFile failed or was short",
        ));
    }
    if unsafe { FlushFileBuffers(raw) } == 0 {
        return Err(LedgerCreateError::AfterCreate(
            "ledger FlushFileBuffers failed",
        ));
    }
    readback(raw, record).map_err(LedgerCreateError::AfterCreate)?;
    verify_file_handle(raw, false).map_err(LedgerCreateError::AfterCreate)?;
    if query_ledger_security(raw).map_err(LedgerCreateError::AfterCreate)? != security {
        return Err(LedgerCreateError::AfterCreate(
            "ledger security drifted during write/flush/readback",
        ));
    }
    Ok(file)
}

/// Creates once with the fixed descriptor, proves empty-file security, writes once,
/// flushes, verifies exact same-handle content/security, and transfers handle ownership.
/// The caller retains responsibility for its exact namespace/identity pins and close/reopen gate.
pub fn create_new_ledger(path: &str, record: &[u8]) -> Result<File, LedgerCreateError> {
    let descriptor =
        descriptor_from_sddl(INITIAL_LEDGER_SDDL).map_err(LedgerCreateError::BeforeCreate)?;
    create_with_descriptor(path, record, descriptor, |_, _| Ok(()))
}

/// Reopen only after closing the writable creation handle; share-write/delete stay denied.
/// The caller must additionally compare retained file identity/path and record bytes.
pub fn reopen_ledger(path: &str, expected: &LedgerSecuritySnapshot) -> Result<File, &'static str> {
    let text = wide(path)?;
    let raw = unsafe {
        CreateFileW(
            text.as_ptr(),
            GENERIC_READ | FILE_READ_ATTRIBUTES | READ_CONTROL,
            FILE_SHARE_READ,
            null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE || raw.is_null() {
        return Err("ledger read-only reopen failed");
    }
    let file = unsafe { File::from_raw_handle(raw) };
    verify_file_handle(file.as_raw_handle(), false)?;
    if &query_ledger_security(file.as_raw_handle())? != expected {
        return Err("ledger reopened security bytes differ");
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::fs::MetadataExt;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    const FIXTURE_ROOT: &str = r"C:\Neurobro\scratch\phase3-prestart-p-g2-native-fixtures-20260905\ledger-security";
    static NEXT: AtomicU64 = AtomicU64::new(0);
    thread_local! { static CREATE_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }
    pub(super) fn test_create_boundary(path: &str) {
        CREATE_CALLS.with(|count| count.set(count.get() + 1));
        assert!(
            path.starts_with(FIXTURE_ROOT),
            "tests cannot invoke CREATE_NEW on a product/host path"
        );
    }
    pub(super) fn create_calls() -> usize {
        CREATE_CALLS.with(|count| count.get())
    }
    thread_local! { static CREATED_UNKNOWN: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }
    pub(super) fn inject_created_unknown() -> bool {
        CREATED_UNKNOWN.with(|v| v.replace(false))
    }
    fn isolated_child(case: &str) -> bool {
        const KEY: &str = "RM0032_LEDGER_SECURITY_TEST_CHILD";
        if let Ok(actual) = std::env::var(KEY) {
            assert_eq!(actual, case);
            println!("LEDGER_FIXTURE_CHILD_ENTER:{case}");
            return true;
        }
        use super::super::native_launcher_privilege::fixture_privilege_snapshot;
        let before = fixture_privilege_snapshot();
        let module = module_path!().split_once("::").unwrap().1;
        let selector = format!("{module}::{case}");
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &selector, "--nocapture", "--test-threads=1"])
            .env(KEY, case)
            .output()
            .unwrap();
        assert_eq!(
            fixture_privilege_snapshot(),
            before,
            "ledger test parent token changed"
        );
        assert!(
            output.status.success(),
            "ledger child {case}: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            String::from_utf8_lossy(&output.stdout)
                .contains(&format!("LEDGER_FIXTURE_CHILD_ENTER:{case}"))
        );
        false
    }

    const CAUSAL_ROOT: &str = r"C:\Neurobro\scratch\phase3-prestart-p-g2-native-fixtures-20260905\ledger-security\causal-sacl-20260905-01";
    fn write_once(path: &std::path::Path, bytes: &[u8]) {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .unwrap();
        file.write_all(bytes).unwrap();
        file.sync_all().unwrap();
    }
    #[test]
    #[ignore = "one owner-admitted causal attempt; never rerun by aggregate"]
    fn ledger_sacl_causal_once() {
        use super::super::native_launcher_privilege::fixture_privilege_snapshot;
        let root = PathBuf::from(CAUSAL_ROOT);
        let intent: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join("intent.json")).unwrap()).unwrap();
        assert_eq!(intent["attemptId"], "causal-sacl-20260905-01");
        assert_eq!(intent["sddl"], INITIAL_LEDGER_SDDL);
        assert_eq!(intent["privilege"], "SeSecurityPrivilege");
        let before = fixture_privilege_snapshot();
        write_once(
            &root.join("dispatched.json"),
            b"{\"outcome\":\"UNKNOWN\",\"retry\":false}\n",
        );
        let module = module_path!().split_once("::").unwrap().1;
        let selector = format!("{module}::ledger_sacl_causal_child");
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                &selector,
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("RM0032_LEDGER_CAUSAL_CHILD", "causal-sacl-20260905-01")
            .output()
            .unwrap();
        let unchanged = fixture_privilege_snapshot() == before;
        write_once(&root.join("parent-result.json"), &serde_json::to_vec(&serde_json::json!({
            "childExit":output.status.code(), "parentTokenUnchanged":unchanged,
            "stdout":String::from_utf8_lossy(&output.stdout), "stderr":String::from_utf8_lossy(&output.stderr)
        })).unwrap());
        assert!(unchanged, "causal fixture altered parent token");
        assert!(
            output.status.success(),
            "causal child: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("LEDGER_CAUSAL_PASS"));
    }
    #[test]
    #[ignore = "only the one-shot causal parent may dispatch this child"]
    fn ledger_sacl_causal_child() {
        use super::super::native_launcher_privilege::{
            ScopedLedgerSaclPrivilege, fixture_privilege_snapshot, fixture_security_enabled,
        };
        assert_eq!(
            std::env::var("RM0032_LEDGER_CAUSAL_CHILD").unwrap(),
            "causal-sacl-20260905-01"
        );
        let root = PathBuf::from(CAUSAL_ROOT);
        let before = fixture_privilege_snapshot();
        assert!(
            !fixture_security_enabled(),
            "causal premise requires held disabled SeSecurity"
        );
        let descriptor = descriptor_from_sddl(INITIAL_LEDGER_SDDL).unwrap();
        let mut scope = ScopedLedgerSaclPrivilege::acquire().unwrap();
        scope.verify_enabled().unwrap();
        let result = create_initial_handle(
            root.join("created-ledger.json").to_str().unwrap(),
            descriptor,
        );
        // Capture the exact outcome before any later assertion, query or write.
        let outcome = format!("{:?}", result.as_ref().map(|_| "CREATED"));
        let restored = scope.restore_verified();
        let restore_outcome = format!("{restored:?}");
        drop(scope);
        let unchanged = fixture_privilege_snapshot() == before;
        write_once(
            &root.join("child-result.json"),
            &serde_json::to_vec(&serde_json::json!({
                "createOutcome":outcome, "restoreOutcome":restore_outcome,
                "childTokenRestored":unchanged, "sddl":INITIAL_LEDGER_SDDL
            }))
            .unwrap(),
        );
        assert!(restored.is_ok() && unchanged);
        let file = result.unwrap();
        assert_eq!(file.metadata().unwrap().len(), 0);
        query_ledger_security(file.as_raw_handle()).unwrap();
        verify_file_handle(file.as_raw_handle(), true).unwrap();
        println!("LEDGER_CAUSAL_PASS");
    }

    fn fixture_path(label: &str) -> String {
        let root = PathBuf::from(FIXTURE_ROOT);
        // Refuse existing redirection before creating any task-private directory.
        for ancestor in root.ancestors() {
            match std::fs::symlink_metadata(ancestor) {
                Ok(metadata) => {
                    assert!(metadata.is_dir());
                    assert_eq!(metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT, 0);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => panic!("fixture ancestor inspection failed: {error}"),
            }
        }
        std::fs::create_dir_all(&root).expect("task-private ledger fixture root");
        let time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = root.join(format!(
            "{label}-{}-{time}-{}.json",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        assert_eq!(path.parent(), Some(root.as_path()));
        path.to_str().unwrap().to_owned()
        // Retain all fixture files, including failed/consumed ledgers, for the parent consumer.
    }

    #[test]
    fn ledger_create_security_before_write_flush_readback_reopen_and_collision() {
        if !isolated_child(
            "ledger_create_security_before_write_flush_readback_reopen_and_collision",
        ) {
            return;
        }
        use super::super::native_launcher_privilege::{
            fixture_privilege_snapshot, fixture_security_enabled,
        };
        let before = fixture_privilege_snapshot();
        assert!(!fixture_security_enabled());
        let path = fixture_path("successful-ledger");
        let record = b"{\"fixture\":\"ledger-security-production-helper\"}\n";
        let mut observed_before_write = false;
        let file = create_with_descriptor(
            &path,
            record,
            descriptor_from_sddl(INITIAL_LEDGER_SDDL).unwrap(),
            |file, snapshot| {
                observed_before_write = true;
                assert!(
                    !fixture_security_enabled(),
                    "restore must precede callback and write"
                );
                assert_eq!(fixture_privilege_snapshot(), before);
                assert_eq!(file.metadata().unwrap().len(), 0);
                assert_eq!(snapshot.owner_sid, "S-1-5-32-544");
                assert_eq!(snapshot.dacl_ace_count, 2);
                assert!(snapshot.low_integrity_no_write_up);
                assert!(!snapshot.descriptor_bytes.is_empty());
                assert_eq!(
                    &query_ledger_security(file.as_raw_handle()).unwrap(),
                    snapshot
                );
                verify_file_handle(file.as_raw_handle(), true).unwrap();
                Ok(())
            },
        )
        .unwrap();
        assert!(
            observed_before_write,
            "actual created empty handle must be observed before WriteFile"
        );
        readback(file.as_raw_handle(), record).unwrap();
        let security = query_ledger_security(file.as_raw_handle()).unwrap();
        let created_id = file_identity(file.as_raw_handle());
        drop(file);
        let reopened = reopen_ledger(&path, &security).unwrap();
        assert_eq!(created_id, file_identity(reopened.as_raw_handle()));
        readback(reopened.as_raw_handle(), record).unwrap();
        assert_eq!(
            query_ledger_security(reopened.as_raw_handle()).unwrap(),
            security
        );
        drop(reopened);
        assert!(matches!(
            create_new_ledger(&path, b"must-not-replace"),
            Err(LedgerCreateError::Collision)
        ));
        let preserved = reopen_ledger(&path, &security).unwrap();
        readback(preserved.as_raw_handle(), record).unwrap();
        assert_eq!(created_id, file_identity(preserved.as_raw_handle()));
        assert_eq!(fixture_privilege_snapshot(), before);
    }

    fn file_identity(handle: HANDLE) -> (u64, [u8; 16]) {
        use windows_sys::Win32::Storage::FileSystem::{FILE_ID_INFO, FileIdInfo};
        let mut id: FILE_ID_INFO = unsafe { zeroed() };
        assert_ne!(
            unsafe {
                GetFileInformationByHandleEx(
                    handle,
                    FileIdInfo,
                    (&mut id as *mut FILE_ID_INFO).cast(),
                    size_of::<FILE_ID_INFO>() as u32,
                )
            },
            0
        );
        (id.VolumeSerialNumber, id.FileId.Identifier)
    }

    #[test]
    fn ledger_incorrect_actual_label_fails_before_write_and_retains_consumed_file() {
        if !isolated_child(
            "ledger_incorrect_actual_label_fails_before_write_and_retains_consumed_file",
        ) {
            return;
        }
        let path = fixture_path("wrong-label-consumed");
        let mut reached_write_boundary = false;
        let result = create_with_descriptor(
            &path,
            b"must-not-be-written",
            descriptor_from_sddl("O:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)S:P(ML;;NW;;;ME)").unwrap(),
            |_, _| {
                reached_write_boundary = true;
                Ok(())
            },
        );
        assert!(matches!(result, Err(LedgerCreateError::AfterCreate(_))));
        assert!(!reached_write_boundary);
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 0);
        assert!(matches!(
            create_new_ledger(&path, b"no-retry"),
            Err(LedgerCreateError::Collision)
        ));
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 0);
    }

    #[test]
    fn ledger_reopen_rejects_changed_security_snapshot_bytes() {
        if !isolated_child("ledger_reopen_rejects_changed_security_snapshot_bytes") {
            return;
        }
        let path = fixture_path("snapshot-mismatch");
        let file = create_new_ledger(&path, b"retained-fixture").unwrap();
        let mut snapshot = query_ledger_security(file.as_raw_handle()).unwrap();
        drop(file);
        snapshot.descriptor_bytes[0] ^= 1;
        assert!(reopen_ledger(&path, &snapshot).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"retained-fixture");
    }

    #[test]
    fn ledger_already_enabled_security_is_preserved() {
        if !isolated_child("ledger_already_enabled_security_is_preserved") {
            return;
        }
        use super::super::native_launcher_privilege::{
            fixture_privilege_snapshot, fixture_security_enabled, fixture_set_security,
        };
        fixture_set_security(true, false).unwrap();
        let before = fixture_privilege_snapshot();
        let path = fixture_path("already-enabled");
        let file = create_with_descriptor(
            &path,
            b"enabled baseline",
            descriptor_from_sddl(INITIAL_LEDGER_SDDL).unwrap(),
            |_, _| {
                assert!(fixture_security_enabled());
                assert_eq!(fixture_privilege_snapshot(), before);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(fixture_privilege_snapshot(), before);
        drop(file);
        fixture_set_security(false, false).unwrap();
    }
    #[test]
    fn ledger_security_absent_refuses_before_create_and_not_all_assigned() {
        if !isolated_child("ledger_security_absent_refuses_before_create_and_not_all_assigned") {
            return;
        }
        use super::super::native_launcher_privilege::fixture_set_security;
        fixture_set_security(false, true).unwrap();
        let path = fixture_path("absent-privilege-no-create");
        assert!(matches!(
            create_new_ledger(&path, b"forbidden"),
            Err(LedgerCreateError::BeforeCreate(_))
        ));
        assert!(!std::path::Path::new(&path).exists());
        assert!(
            fixture_set_security(true, false)
                .unwrap_err()
                .contains("ERROR_NOT_ALL_ASSIGNED")
        );
    }
    #[test]
    fn ledger_acquire_readback_failure_restores_before_any_create() {
        if !isolated_child("ledger_acquire_readback_failure_restores_before_any_create") {
            return;
        }
        use super::super::native_launcher_privilege::{
            fixture_fail_readback, fixture_privilege_snapshot,
        };
        let before = fixture_privilege_snapshot();
        let path = fixture_path("acquire-readback-no-create");
        fixture_fail_readback(2);
        assert!(matches!(
            create_new_ledger(&path, b"forbidden"),
            Err(LedgerCreateError::BeforeCreate(_))
        ));
        assert!(!std::path::Path::new(&path).exists());
        assert_eq!(fixture_privilege_snapshot(), before);
    }
    #[test]
    fn ledger_acquire_and_restore_double_failure_is_unknown_before_create() {
        if !isolated_child("ledger_acquire_and_restore_double_failure_is_unknown_before_create") {
            return;
        }
        use super::super::native_launcher_privilege::{
            fixture_fail_acquire_and_restore_readback, fixture_privilege_snapshot,
        };
        assert!(!super::super::native_launcher_privilege::fixture_security_enabled());
        let before = fixture_privilege_snapshot();
        let path = fixture_path("acquire-restore-unknown");
        fixture_fail_acquire_and_restore_readback();
        assert!(matches!(
            create_new_ledger(&path, b"forbidden"),
            Err(LedgerCreateError::PrivilegeRestoration(_))
        ));
        assert!(!std::path::Path::new(&path).exists());
        assert_eq!(fixture_privilege_snapshot(), before);
    }
    #[test]
    fn ledger_failed_create_restores_and_preserves_immediate_error() {
        if !isolated_child("ledger_failed_create_restores_and_preserves_immediate_error") {
            return;
        }
        use super::super::native_launcher_privilege::{
            fixture_fail_readback, fixture_privilege_snapshot,
        };
        let before = fixture_privilege_snapshot();
        let path = format!(
            r"{}\missing\record.json",
            fixture_path("nonexistent-parent")
        );
        assert_eq!(
            create_new_ledger(&path, b"forbidden").unwrap_err(),
            LedgerCreateError::CreateFailed(3)
        );
        assert_eq!(fixture_privilege_snapshot(), before);
        let second = format!(
            r"{}\missing\record.json",
            fixture_path("failed-create-restore")
        );
        fixture_fail_readback(3);
        assert!(matches!(
            create_new_ledger(&second, b"forbidden"),
            Err(LedgerCreateError::PrivilegeRestoration(_))
        ));
        assert_eq!(fixture_privilege_snapshot(), before);
    }
    #[test]
    fn ledger_created_restore_failure_and_unknown_are_consumed_before_write() {
        if !isolated_child("ledger_created_restore_failure_and_unknown_are_consumed_before_write") {
            return;
        }
        use super::super::native_launcher_privilege::{
            fixture_fail_readback, fixture_privilege_snapshot,
        };
        let before = fixture_privilege_snapshot();
        for fault in ["restore-readback", "created-unknown"] {
            let path = fixture_path(fault);
            if fault == "restore-readback" {
                fixture_fail_readback(3);
            } else {
                CREATED_UNKNOWN.with(|v| v.set(true));
            }
            let mut callback = false;
            let result = create_with_descriptor(
                &path,
                b"must-not-write",
                descriptor_from_sddl(INITIAL_LEDGER_SDDL).unwrap(),
                |_, _| {
                    callback = true;
                    Ok(())
                },
            );
            assert!(matches!(result, Err(LedgerCreateError::AfterCreate(_))));
            assert!(!callback);
            assert_eq!(std::fs::metadata(&path).unwrap().len(), 0);
            assert_eq!(fixture_privilege_snapshot(), before);
            assert!(matches!(
                create_new_ledger(&path, b"no-retry"),
                Err(LedgerCreateError::Collision)
            ));
            assert_eq!(std::fs::metadata(&path).unwrap().len(), 0);
        }
    }
}
