//! Launcher-local quota privilege. This never grants an account right and never
//! accepts an observer/parent token. Keep the guard through native cleanup and
//! explicitly restore it before reporting success; Drop is only a safety net.
#![cfg(windows)]

use std::mem::{offset_of, size_of, zeroed};
use std::ptr::{null, null_mut};
use std::sync::{Mutex, MutexGuard};
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_INSUFFICIENT_BUFFER, ERROR_NOT_ALL_ASSIGNED, ERROR_SUCCESS, GetLastError,
    HANDLE, LUID, SetLastError,
};
use windows_sys::Win32::Security::{
    AdjustTokenPrivileges, DuplicateTokenEx, GetTokenInformation, LUID_AND_ATTRIBUTES,
    LookupPrivilegeValueW, PRIVILEGE_SET, PrivilegeCheck, SE_PRIVILEGE_ENABLED,
    SE_PRIVILEGE_ENABLED_BY_DEFAULT, SE_PRIVILEGE_REMOVED, SE_PRIVILEGE_USED_FOR_ACCESS,
    SecurityImpersonation, TOKEN_ADJUST_PRIVILEGES, TOKEN_DUPLICATE, TOKEN_PRIVILEGES, TOKEN_QUERY,
    TokenImpersonation, TokenPrivileges,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

// Nested/concurrent scopes could restore each other's state. Refuse overlap;
// the launcher has one serialized native operation per process.
static QUOTA_SCOPE: Mutex<()> = Mutex::new(());
static LEDGER_SACL_SCOPE: Mutex<()> = Mutex::new(());
const RESTORABLE: u32 = SE_PRIVILEGE_ENABLED | SE_PRIVILEGE_ENABLED_BY_DEFAULT;

#[derive(Debug)]
pub enum AcquireError {
    Refused(String),
    RestorationUnknown(String),
}
impl From<String> for AcquireError {
    fn from(reason: String) -> Self {
        Self::Refused(reason)
    }
}
impl From<&str> for AcquireError {
    fn from(reason: &str) -> Self {
        Self::Refused(reason.into())
    }
}
impl std::fmt::Display for AcquireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused(reason) | Self::RestorationUnknown(reason) => f.write_str(reason),
        }
    }
}

struct Token(HANDLE);
impl Drop for Token {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

fn process_token() -> Result<Token, String> {
    let mut raw = null_mut();
    if unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_QUERY | TOKEN_ADJUST_PRIVILEGES | TOKEN_DUPLICATE,
            &mut raw,
        )
    } == 0
    {
        return Err(format!("quota OpenProcessToken failed: {}", unsafe {
            GetLastError()
        }));
    }
    if raw.is_null() {
        return Err("quota OpenProcessToken returned null".into());
    }
    Ok(Token(raw))
}

#[cfg(test)]
fn quota_luid() -> Result<LUID, String> {
    named_luid("SeIncreaseQuotaPrivilege")
}
fn named_luid(name: &str) -> Result<LUID, String> {
    let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    let mut luid = unsafe { zeroed() };
    if unsafe { LookupPrivilegeValueW(null(), name.as_ptr(), &mut luid) } == 0 {
        return Err(format!("quota LookupPrivilegeValueW failed: {}", unsafe {
            GetLastError()
        }));
    }
    Ok(luid)
}

fn same_luid(a: LUID, b: LUID) -> bool {
    a.LowPart == b.LowPart && a.HighPart == b.HighPart
}

fn privileges(token: HANDLE) -> Result<Vec<LUID_AND_ATTRIBUTES>, String> {
    let mut required = 0;
    let first =
        unsafe { GetTokenInformation(token, TokenPrivileges, null_mut(), 0, &mut required) };
    let error = unsafe { GetLastError() };
    if first != 0 || error != ERROR_INSUFFICIENT_BUFFER || !(4..=65536).contains(&required) {
        return Err("quota TokenPrivileges length query refused".into());
    }
    let mut bytes = vec![0u8; required as usize];
    let capacity = required;
    if unsafe {
        GetTokenInformation(
            token,
            TokenPrivileges,
            bytes.as_mut_ptr().cast(),
            capacity,
            &mut required,
        )
    } == 0
        || required > capacity
        || required < 4
    {
        return Err("quota TokenPrivileges readback failed".into());
    }
    bytes.truncate(required as usize);
    let count = u32::from_ne_bytes(bytes[..4].try_into().unwrap()) as usize;
    let offset = offset_of!(TOKEN_PRIVILEGES, Privileges);
    let end = count
        .checked_mul(size_of::<LUID_AND_ATTRIBUTES>())
        .and_then(|size| size.checked_add(offset))
        .ok_or("quota TokenPrivileges size overflow")?;
    if end > bytes.len() {
        return Err("quota TokenPrivileges truncated".into());
    }
    let mut result: Vec<LUID_AND_ATTRIBUTES> = Vec::with_capacity(count);
    for index in 0..count {
        let value = unsafe {
            bytes
                .as_ptr()
                .add(offset + index * size_of::<LUID_AND_ATTRIBUTES>())
                .cast::<LUID_AND_ATTRIBUTES>()
                .read_unaligned()
        };
        if result
            .iter()
            .any(|previous| same_luid(previous.Luid, value.Luid))
        {
            return Err("quota TokenPrivileges duplicate LUID".into());
        }
        result.push(value);
    }
    // Fault is compiled only into tests and runs AFTER the actual API/readback.
    #[cfg(test)]
    if tests::readback_fault() {
        return Err("quota injected actual-token readback failure".into());
    }
    Ok(result)
}

fn attributes(token: HANDLE, luid: LUID) -> Result<u32, String> {
    let attributes = privileges(token)?
        .into_iter()
        .find(|entry| same_luid(entry.Luid, luid))
        .ok_or("requested launcher privilege is not already held")?
        .Attributes;
    if attributes & SE_PRIVILEGE_REMOVED != 0
        || attributes & !(RESTORABLE | SE_PRIVILEGE_USED_FOR_ACCESS) != 0
    {
        return Err("quota privilege attributes are not restorable".into());
    }
    Ok(attributes & RESTORABLE)
}

fn adjust(token: HANDLE, luid: LUID, attributes: u32) -> Result<(), String> {
    let requested = TOKEN_PRIVILEGES {
        PrivilegeCount: 1,
        Privileges: [LUID_AND_ATTRIBUTES {
            Luid: luid,
            Attributes: attributes,
        }],
    };
    unsafe { SetLastError(ERROR_SUCCESS) };
    let ok = unsafe { AdjustTokenPrivileges(token, 0, &requested, 0, null_mut(), null_mut()) };
    // BOOL success alone explicitly does not mean the privilege was assigned.
    let error = unsafe { GetLastError() };
    if ok == 0 || error != ERROR_SUCCESS {
        return Err(if error == ERROR_NOT_ALL_ASSIGNED {
            "quota AdjustTokenPrivileges ERROR_NOT_ALL_ASSIGNED".into()
        } else {
            format!("quota AdjustTokenPrivileges failed: BOOL={ok}, error={error}")
        });
    }
    Ok(())
}

fn check(token: HANDLE, luid: LUID, expected_enabled: bool) -> Result<(), String> {
    // PrivilegeCheck requires an impersonation token. This is a fresh query-only
    // snapshot of OUR process token, not a token installed on any thread/child.
    let mut raw = null_mut();
    if unsafe {
        DuplicateTokenEx(
            token,
            TOKEN_QUERY,
            null(),
            SecurityImpersonation,
            TokenImpersonation,
            &mut raw,
        )
    } == 0
    {
        return Err("quota PrivilegeCheck token duplication failed".into());
    }
    let query = Token(raw);
    let mut needed = PRIVILEGE_SET {
        PrivilegeCount: 1,
        Control: 1, // PRIVILEGE_SET_ALL_NECESSARY
        Privilege: [LUID_AND_ATTRIBUTES {
            Luid: luid,
            Attributes: SE_PRIVILEGE_ENABLED,
        }],
    };
    let mut enabled = 0;
    if unsafe { PrivilegeCheck(query.0, &mut needed, &mut enabled) } == 0 {
        return Err("quota PrivilegeCheck failed".into());
    }
    if (enabled != 0) != expected_enabled {
        return Err("quota PrivilegeCheck enabled state disagrees".into());
    }
    Ok(())
}

#[must_use = "hold through native cleanup and call restore_verified before success"]
struct ScopedPrivilege {
    token: Token,
    luid: LUID,
    previous: u32,
    changed: bool,
    restored: bool,
    _exclusive: MutexGuard<'static, ()>,
}

impl ScopedPrivilege {
    fn acquire(name: &str, lock: &'static Mutex<()>) -> Result<Self, AcquireError> {
        let exclusive = lock
            .try_lock()
            .map_err(|_| "quota scope overlapping or poisoned")?;
        let token = process_token()?;
        let luid = named_luid(name)?;
        let previous = attributes(token.0, luid)?;
        // Arm cleanup BEFORE the first adjustment, including uncertain failure.
        let mut scope = Self {
            token,
            luid,
            previous,
            changed: previous & SE_PRIVILEGE_ENABLED == 0,
            restored: false,
            _exclusive: exclusive,
        };
        let acquired = (|| {
            if scope.changed {
                adjust(scope.token.0, luid, previous | SE_PRIVILEGE_ENABLED)?;
            }
            scope.verify_enabled()
        })();
        if let Err(error) = acquired {
            return match scope.restore_verified() {
                Ok(()) => Err(AcquireError::Refused(error)),
                Err(restore) => Err(AcquireError::RestorationUnknown(format!(
                    "{error}; explicit quota restoration failed: {restore}"
                ))),
            };
        }
        Ok(scope)
    }

    pub fn verify_enabled(&self) -> Result<(), String> {
        if self.restored {
            return Err("quota scope already restored".into());
        }
        if attributes(self.token.0, self.luid)? != self.previous | SE_PRIVILEGE_ENABLED {
            return Err("quota actual-token enabled readback disagrees".into());
        }
        check(self.token.0, self.luid, true)
    }

    pub fn restore_verified(&mut self) -> Result<(), String> {
        if !self.restored && self.changed {
            adjust(self.token.0, self.luid, self.previous)?;
        }
        if attributes(self.token.0, self.luid)? != self.previous {
            return Err("quota previous state restoration readback disagrees".into());
        }
        check(
            self.token.0,
            self.luid,
            self.previous & SE_PRIVILEGE_ENABLED != 0,
        )?;
        self.restored = true;
        Ok(())
    }
}

impl Drop for ScopedPrivilege {
    fn drop(&mut self) {
        if self.changed && !self.restored {
            let _ = adjust(self.token.0, self.luid, self.previous);
        }
    }
}

/// Already-held quota right, confined to this launcher process and lifetime.
#[must_use]
pub struct ScopedQuotaPrivilege(ScopedPrivilege);
impl ScopedQuotaPrivilege {
    pub fn acquire() -> Result<Self, AcquireError> {
        ScopedPrivilege::acquire("SeIncreaseQuotaPrivilege", &QUOTA_SCOPE).map(Self)
    }
    pub fn verify_enabled(&self) -> Result<(), String> {
        self.0.verify_enabled()
    }
    pub fn restore_verified(&mut self) -> Result<(), String> {
        self.0.restore_verified()
    }
}

/// Already-held SeSecurity only for the atomic initial ledger descriptor.
/// Restore explicitly immediately after CREATE_NEW, before query/callback/write.
#[must_use]
pub struct ScopedLedgerSaclPrivilege(ScopedPrivilege);
impl ScopedLedgerSaclPrivilege {
    pub fn acquire() -> Result<Self, AcquireError> {
        ScopedPrivilege::acquire("SeSecurityPrivilege", &LEDGER_SACL_SCOPE).map(Self)
    }
    #[cfg(test)]
    pub fn verify_enabled(&self) -> Result<(), String> {
        self.0.verify_enabled()
    }
    pub fn restore_verified(&mut self) -> Result<(), String> {
        self.0.restore_verified()
    }
}

#[cfg(test)]
pub(crate) fn fixture_privilege_snapshot() -> Vec<(i32, u32, u32)> {
    let token = process_token().unwrap();
    let mut result: Vec<_> = privileges(token.0)
        .unwrap()
        .into_iter()
        .map(|p| {
            (
                p.Luid.HighPart,
                p.Luid.LowPart,
                p.Attributes & !SE_PRIVILEGE_USED_FOR_ACCESS,
            )
        })
        .collect();
    result.sort_unstable();
    result
}
#[cfg(test)]
pub(crate) fn fixture_security_enabled() -> bool {
    let token = process_token().unwrap();
    attributes(token.0, named_luid("SeSecurityPrivilege").unwrap()).unwrap() & SE_PRIVILEGE_ENABLED
        != 0
}
#[cfg(test)]
pub(crate) fn fixture_set_security(enabled: bool, remove: bool) -> Result<(), String> {
    let token = process_token()?;
    let luid = named_luid("SeSecurityPrivilege")?;
    adjust(
        token.0,
        luid,
        if remove {
            SE_PRIVILEGE_REMOVED
        } else if enabled {
            SE_PRIVILEGE_ENABLED
        } else {
            0
        },
    )
}
#[cfg(test)]
pub(crate) fn fixture_fail_readback(number: usize) {
    tests::set_readback_fault(number);
}
#[cfg(test)]
pub(crate) fn fixture_fail_acquire_and_restore_readback() {
    tests::set_double_readback_fault();
}
#[cfg(test)]
pub(crate) fn fixture_disable_quota() {
    let token = process_token().unwrap();
    adjust(token.0, quota_luid().unwrap(), 0).unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    const CHILD_ENV: &str = "RM0032_QUOTA_FIXTURE_CHILD_CASE";
    thread_local! { static FAIL_READ_NUMBER: Cell<usize> = const { Cell::new(0) }; }
    pub(super) fn readback_fault() -> bool {
        FAIL_READ_NUMBER.with(|remaining| {
            let value = remaining.get();
            if value == 0 {
                return false;
            }
            remaining.set(value >> 1);
            value & 1 != 0
        })
    }
    pub(super) fn set_readback_fault(number: usize) {
        FAIL_READ_NUMBER.with(|n| n.set(1 << (number - 1)));
    }
    pub(super) fn set_double_readback_fault() {
        FAIL_READ_NUMBER.with(|n| n.set(0b110));
    }

    fn snapshot() -> Vec<(i32, u32, u32)> {
        let token = process_token().unwrap();
        let mut snapshot: Vec<_> = privileges(token.0)
            .unwrap()
            .into_iter()
            .map(|p| {
                (
                    p.Luid.HighPart,
                    p.Luid.LowPart,
                    p.Attributes & !SE_PRIVILEGE_USED_FOR_ACCESS,
                )
            })
            .collect();
        snapshot.sort_unstable();
        snapshot
    }

    fn run_child(case: &str) {
        assert!(
            std::env::var_os(CHILD_ENV).is_none(),
            "nested fixture forbidden"
        );
        let before = snapshot();
        let module = module_path!().split_once("::").unwrap().1;
        let selector = format!("{module}::quota_privilege_child");
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                &selector,
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(CHILD_ENV, case)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let started = Instant::now();
        loop {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            if started.elapsed() > Duration::from_secs(15) {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("quota fixture child timed out: {case}");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let output = child.wait_with_output().unwrap();
        assert_eq!(snapshot(), before, "test parent process token changed");
        assert!(
            output.status.success(),
            "quota child {case}: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            String::from_utf8_lossy(&output.stdout).contains(&format!("QUOTA_CHILD_PASS:{case}")),
            "child selector did not exercise fixture"
        );
    }

    #[test]
    fn quota_enabled_and_parent_unchanged() {
        run_child("enabled");
    }
    #[test]
    fn quota_disabled_and_parent_unchanged() {
        run_child("disabled");
    }
    #[test]
    fn quota_missing_and_not_all_assigned() {
        run_child("missing");
    }
    #[test]
    fn quota_actual_readback_failure_restores() {
        run_child("readback-failure");
    }
    #[test]
    fn quota_acquire_and_restore_readback_unknown_is_preserved() {
        run_child("acquire-restore-unknown");
    }
    #[test]
    fn quota_restore_failure_is_not_success() {
        run_child("restore-failure");
    }
    #[test]
    fn quota_drop_best_effort_restores() {
        run_child("drop");
    }
    #[test]
    fn quota_overlap_refused() {
        run_child("overlap");
    }

    // Never changes the cargo/test parent or its invoking shell token. This
    // ignored entry is dispatched only as an exact, short-lived test child.
    #[test]
    #[ignore = "invoked only by quota parent fixtures with exact child selector"]
    fn quota_privilege_child() {
        let case = std::env::var(CHILD_ENV).expect("exact child fixture dispatch required");
        let token = process_token().unwrap();
        let luid = quota_luid().unwrap();
        let original =
            attributes(token.0, luid).expect("fixture requires already-held quota right");
        let baseline = if case == "enabled" {
            original | SE_PRIVILEGE_ENABLED
        } else {
            original & !SE_PRIVILEGE_ENABLED
        };
        adjust(token.0, luid, baseline).unwrap();
        assert_eq!(attributes(token.0, luid).unwrap(), baseline);
        check(token.0, luid, baseline & SE_PRIVILEGE_ENABLED != 0).unwrap();
        let before = snapshot();
        match case.as_str() {
            "missing" => {
                // Removal is irreversible ONLY in this disposable child token;
                // no account policy or invoking process token is ever opened.
                adjust(token.0, luid, SE_PRIVILEGE_REMOVED).unwrap();
                assert!(
                    attributes(token.0, luid)
                        .unwrap_err()
                        .contains("not already held")
                );
                assert!(
                    ScopedQuotaPrivilege::acquire()
                        .err()
                        .unwrap()
                        .to_string()
                        .contains("not already held")
                );
                assert!(
                    adjust(token.0, luid, SE_PRIVILEGE_ENABLED)
                        .unwrap_err()
                        .contains("ERROR_NOT_ALL_ASSIGNED")
                );
            }
            "readback-failure" => {
                FAIL_READ_NUMBER.with(|counter| counter.set(2));
                let error = ScopedQuotaPrivilege::acquire().err().unwrap();
                assert!(matches!(error, AcquireError::Refused(_)));
                assert!(
                    error
                        .to_string()
                        .contains("injected actual-token readback failure")
                );
                assert!(
                    !error
                        .to_string()
                        .contains("explicit quota restoration failed")
                );
                assert_eq!(snapshot(), before);
            }
            "acquire-restore-unknown" => {
                set_double_readback_fault();
                let error = ScopedQuotaPrivilege::acquire().err().unwrap();
                assert!(matches!(error, AcquireError::RestorationUnknown(_)));
                assert!(
                    error
                        .to_string()
                        .contains("explicit quota restoration failed")
                );
                // Drop's best-effort actual restoration cannot erase UNKNOWN.
                assert_eq!(snapshot(), before);
            }
            "enabled" | "disabled" | "restore-failure" | "drop" | "overlap" => {
                let mut scope = ScopedQuotaPrivilege::acquire().unwrap();
                scope.verify_enabled().unwrap();
                assert_eq!(
                    attributes(token.0, luid).unwrap(),
                    baseline | SE_PRIVILEGE_ENABLED
                );
                if case == "overlap" {
                    assert!(
                        ScopedQuotaPrivilege::acquire()
                            .err()
                            .unwrap()
                            .to_string()
                            .contains("overlapping")
                    );
                    scope.verify_enabled().unwrap();
                }
                if case == "restore-failure" {
                    FAIL_READ_NUMBER.with(|counter| counter.set(1));
                    assert!(
                        scope
                            .restore_verified()
                            .unwrap_err()
                            .contains("readback failure")
                    );
                    assert!(
                        !scope.0.restored,
                        "failed restoration cannot claim verified success"
                    );
                } else if case != "drop" {
                    scope.restore_verified().unwrap();
                    scope.restore_verified().unwrap();
                    assert!(scope.verify_enabled().is_err());
                }
                drop(scope);
                assert_eq!(snapshot(), before);
                check(token.0, luid, baseline & SE_PRIVILEGE_ENABLED != 0).unwrap();
            }
            _ => panic!("unknown quota fixture case"),
        }
        println!("QUOTA_CHILD_PASS:{case}");
    }
}
