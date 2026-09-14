//! Shared same-handle primitives; startup ACL policy is deliberately separate
//! from the observer's AppContainer-writable evidence policy.
#![cfg(windows)]
#![allow(dead_code)]

use sha2::{Digest, Sha256};
use std::ffi::c_void;
use std::mem::size_of;
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Security::Authorization::*;
use windows_sys::Win32::Security::*;
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::SystemServices::{ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

#[derive(Debug)]
pub struct OwnedNativeHandle<K> {
    pub raw: HANDLE,
    pub kind: K,
}
impl<K: Copy> OwnedNativeHandle<K> {
    pub fn new(handle: HANDLE, kind: K) -> Result<Self, u32> {
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            Err(unsafe { GetLastError() })
        } else {
            Ok(Self { raw: handle, kind })
        }
    }
    pub fn raw(&self) -> HANDLE {
        self.raw
    }
    pub fn kind(&self) -> K {
        self.kind
    }
}
impl<K> Drop for OwnedNativeHandle<K> {
    fn drop(&mut self) {
        if !self.raw.is_null() && self.raw != INVALID_HANDLE_VALUE {
            unsafe {
                CloseHandle(self.raw);
            }
            self.raw = null_mut();
        }
    }
}
pub type Handle = OwnedNativeHandle<()>;
pub fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

pub fn native_final_path(handle: HANDLE) -> Result<String, &'static str> {
    let required = unsafe { GetFinalPathNameByHandleW(handle, null_mut(), 0, 0) };
    if required == 0 || required > 32_767 {
        return Err("GetFinalPathNameByHandleW length failed");
    }
    let mut buffer = vec![0u16; required as usize + 1];
    let written =
        unsafe { GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, 0) };
    if written == 0 || written as usize >= buffer.len() {
        return Err("GetFinalPathNameByHandleW data failed");
    }
    String::from_utf16(&buffer[..written as usize]).map_err(|_| "final path was not UTF-16")
}
pub fn native_file_info<T: Default>(handle: HANDLE, class: i32) -> Result<T, &'static str> {
    let mut value = T::default();
    if unsafe {
        GetFileInformationByHandleEx(
            handle,
            class,
            (&mut value as *mut T).cast(),
            size_of::<T>() as u32,
        )
    } == 0
    {
        return Err("GetFileInformationByHandleEx failed");
    }
    Ok(value)
}
pub fn native_sha256(handle: HANDLE) -> Result<String, &'static str> {
    if unsafe { SetFilePointerEx(handle, 0, null_mut(), FILE_BEGIN) } == 0 {
        return Err("SetFilePointerEx before hash failed");
    }
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let mut read = 0u32;
        if unsafe {
            ReadFile(
                handle,
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                &mut read,
                null_mut(),
            )
        } == 0
        {
            return Err("ReadFile during hash failed");
        }
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read as usize]);
    }
    if unsafe { SetFilePointerEx(handle, 0, null_mut(), FILE_BEGIN) } == 0 {
        return Err("SetFilePointerEx after hash failed");
    }
    Ok(format!("{:x}", digest.finalize()))
}

struct LocalAllocation(*mut c_void);
impl Drop for LocalAllocation {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}
fn sid_text(sid: PSID) -> Result<String, &'static str> {
    if sid.is_null() || unsafe { IsValidSid(sid) } == 0 {
        return Err("invalid SID");
    }
    let mut text = null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return Err("SID conversion failed");
    }
    let _allocation = LocalAllocation(text.cast());
    let mut length = 0;
    while unsafe { *text.add(length) } != 0 {
        length += 1;
    }
    String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) })
        .map_err(|_| "SID UTF-16 failed")
}

/// The trusted owner is derived from the current process token, never JSON.
pub fn process_owner_sid() -> Result<String, &'static str> {
    let mut raw = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) } == 0 {
        return Err("process token query failed");
    }
    let token = Handle::new(raw, ()).map_err(|_| "invalid process token")?;
    let mut required = 0;
    unsafe {
        GetTokenInformation(token.raw(), TokenUser, null_mut(), 0, &mut required);
    }
    if required < size_of::<TOKEN_USER>() as u32 || required > 65536 {
        return Err("token user size failed");
    }
    // usize storage guarantees TOKEN_USER alignment.
    let mut storage = vec![0usize; (required as usize).div_ceil(size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token.raw(),
            TokenUser,
            storage.as_mut_ptr().cast(),
            required,
            &mut required,
        )
    } == 0
    {
        return Err("token user read failed");
    }
    sid_text(unsafe { (*(storage.as_ptr().cast::<TOKEN_USER>())).User.Sid })
}

#[derive(Clone, Copy, Debug)]
pub enum AclPolicy {
    VolumeRoot,
    SharedAncestor,
    Startup,
    InheritedAttempt,
    FixedWindows,
    FixedGit,
    FixedWsl,
}

const TRUSTED_INSTALLER: &str = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
/// Code chooses the only vendor/OS exceptions. Caller-controlled bindings do
/// not choose a trust class or turn another executable into an OS binary.
pub fn fixed_external_policy(path: &str, directory: bool) -> Option<AclPolicy> {
    match (directory, path) {
        (true, r"C:\Windows" | r"C:\Windows\System32" | r"C:\Program Files") => {
            Some(AclPolicy::FixedWindows)
        }
        (false, r"C:\Program Files\Git\mingw64\bin\git.exe")
        | (
            true,
            r"C:\Program Files\Git"
            | r"C:\Program Files\Git\mingw64"
            | r"C:\Program Files\Git\mingw64\bin",
        ) => {
            Some(AclPolicy::FixedGit)
        }
        (false, r"C:\Program Files\WSL\wsl.exe") | (true, r"C:\Program Files\WSL") => {
            Some(AclPolicy::FixedWsl)
        }
        _ => None,
    }
}

/// Returns complete owner/DACL bytes, not merely ACE count. Shared ancestors
/// may permit unrelated child creation. They may not grant other principals
/// DELETE_CHILD, WRITE_DAC, or WRITE_OWNER on the ancestor itself. DELETE and
/// direct writable opens are excluded by held directory sharing, not an ACL
/// claim; unrelated child creation need not be excluded.
pub fn security_snapshot(
    handle: HANDLE,
    trusted_owner: &str,
    policy: AclPolicy,
) -> Result<Vec<u8>, &'static str> {
    let mut owner = null_mut();
    let mut dacl = null_mut();
    let mut descriptor = null_mut();
    if unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        )
    } != ERROR_SUCCESS
        || descriptor.is_null()
        || owner.is_null()
        || dacl.is_null()
    {
        return Err("startup owner/DACL unavailable");
    }
    let _allocation = LocalAllocation(descriptor);
    let owner_text = sid_text(owner)?;
    let trusted = |sid: &str| {
        sid == trusted_owner
            || sid == "S-1-5-18"
            || sid == "S-1-5-32-544"
            || (matches!(policy, AclPolicy::FixedWindows | AclPolicy::FixedGit | AclPolicy::FixedWsl)
                && sid == TRUSTED_INSTALLER)
    };
    // Drive-root ownership/ACL is the explicit Windows OS trust boundary, not
    // a requirement to reprovision a host volume. Its identity/security is still
    // held and reobserved. Every non-root component uses the stricter rules.
    if !matches!(policy, AclPolicy::VolumeRoot) && !trusted(&owner_text) {
        return Err("startup owner untrusted");
    }
    let mut control = 0;
    let mut revision = 0;
    if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0 {
        return Err("startup descriptor control unavailable");
    }
    if matches!(policy, AclPolicy::Startup) && control & SE_DACL_PROTECTED == 0 {
        return Err("startup DACL is not protected");
    }
    let mut info = ACL_SIZE_INFORMATION::default();
    if unsafe {
        GetAclInformation(
            dacl,
            (&mut info as *mut ACL_SIZE_INFORMATION).cast(),
            size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    } == 0
        || info.AceCount == 0
    {
        return Err("startup ACL unavailable or empty");
    }
    for index in 0..if matches!(policy, AclPolicy::VolumeRoot) {
        0
    } else {
        info.AceCount
    } {
        let mut ace = null_mut();
        if unsafe { GetAce(dacl, index, &mut ace) } == 0 || ace.is_null() {
            return Err("startup ACE unavailable");
        }
        let header = unsafe { &*ace.cast::<ACE_HEADER>() };
        if header.AceFlags as u32 & INHERIT_ONLY_ACE != 0 {
            continue;
        }
        if header.AceType as u32 == ACCESS_DENIED_ACE_TYPE {
            continue;
        }
        if header.AceType as u32 != ACCESS_ALLOWED_ACE_TYPE {
            return Err("unsupported startup ACE type");
        }
        let allowed = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
        let sid = sid_text((&allowed.SidStart as *const u32).cast_mut().cast())?;
        if trusted(&sid) {
            continue;
        }
        let forbidden = match policy {
            AclPolicy::VolumeRoot => unreachable!(),
            AclPolicy::SharedAncestor => FILE_DELETE_CHILD | WRITE_DAC | WRITE_OWNER | GENERIC_ALL,
            AclPolicy::Startup
            | AclPolicy::InheritedAttempt
            | AclPolicy::FixedWindows
            | AclPolicy::FixedGit
            | AclPolicy::FixedWsl => {
                DELETE
                    | FILE_DELETE_CHILD
                    | WRITE_DAC
                    | WRITE_OWNER
                    | GENERIC_ALL
                    | GENERIC_WRITE
                    | FILE_WRITE_DATA
                    | FILE_APPEND_DATA
                    | FILE_WRITE_EA
                    | FILE_WRITE_ATTRIBUTES
            }
        };
        if allowed.Mask & forbidden != 0 {
            return Err("startup ACL grants untrusted mutation");
        }
    }
    let mut result = owner_text.into_bytes();
    result.extend(control.to_le_bytes());
    result
        .extend(unsafe { std::slice::from_raw_parts(dacl.cast::<u8>(), (*dacl).AclSize as usize) });
    Ok(result)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Snapshot {
    pub final_path: String,
    pub volume: u64,
    pub id: [u8; 16],
    pub bytes: i64,
    pub attributes: u32,
    pub link_count: u32,
    pub sha256: Option<String>,
    pub security: Vec<u8>,
}
pub struct Pin {
    pub handle: Handle,
    pub snapshot: Snapshot,
    directory: bool,
    policy: AclPolicy,
    owner: String,
}
/// Shared real open primitive for code-selected pins and benign sharing tests.
pub fn open_readonly_pinned_handle(path: &str, directory: bool) -> Result<Handle, &'static str> {
    let flags = FILE_FLAG_OPEN_REPARSE_POINT
        | if directory {
            FILE_FLAG_BACKUP_SEMANTICS
        } else {
            FILE_ATTRIBUTE_NORMAL
        };
    Handle::new(
        unsafe {
            CreateFileW(
                wide(path).as_ptr(),
                FILE_READ_ATTRIBUTES | READ_CONTROL | FILE_READ_DATA,
                FILE_SHARE_READ,
                null(),
                OPEN_EXISTING,
                flags,
                null_mut(),
            )
        },
        (),
    )
    .map_err(|_| "startup pin open failed")
}
impl Pin {
    pub fn open(
        path: &str,
        directory: bool,
        policy: AclPolicy,
        owner: &str,
    ) -> Result<Self, &'static str> {
        if matches!(policy, AclPolicy::FixedWindows | AclPolicy::FixedGit | AclPolicy::FixedWsl)
            && !matches!(
                (policy, fixed_external_policy(path, directory)),
                (AclPolicy::FixedWindows, Some(AclPolicy::FixedWindows))
                    | (AclPolicy::FixedGit, Some(AclPolicy::FixedGit))
                    | (AclPolicy::FixedWsl, Some(AclPolicy::FixedWsl))
            )
        {
            return Err("fixed external policy used outside code-chosen path");
        }
        if matches!(policy, AclPolicy::VolumeRoot)
            && (!directory
                || path.len() != 3
                || !path.as_bytes()[0].is_ascii_uppercase()
                || &path[1..] != r":\")
        {
            return Err("volume-root policy used outside exact DOS root");
        }
        // A shared ancestor need not exclude writes to unrelated children.
        // No directory is opened with FILE_SHARE_DELETE.
        let handle = open_readonly_pinned_handle(path, directory)?;
        let snapshot = Self::snapshot(handle.raw(), path, directory, policy, owner)?;
        Ok(Self {
            handle,
            snapshot,
            directory,
            policy,
            owner: owner.into(),
        })
    }
    fn snapshot(
        handle: HANDLE,
        path: &str,
        directory: bool,
        policy: AclPolicy,
        owner: &str,
    ) -> Result<Snapshot, &'static str> {
        let final_path = native_final_path(handle)?;
        if final_path != format!(r"\\?\{path}") {
            return Err("startup final path mismatch");
        }
        let id: FILE_ID_INFO = native_file_info(handle, FileIdInfo)?;
        let standard: FILE_STANDARD_INFO = native_file_info(handle, FileStandardInfo)?;
        let basic: FILE_BASIC_INFO = native_file_info(handle, FileBasicInfo)?;
        if standard.Directory != directory
            || standard.DeletePending
            || basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || (!directory
                && standard.NumberOfLinks != 1
                && !(matches!(policy, AclPolicy::FixedWindows | AclPolicy::FixedGit | AclPolicy::FixedWsl)
                    && standard.NumberOfLinks > 0))
        {
            return Err("startup type/reparse/link/delete-pending refused");
        }
        Ok(Snapshot {
            final_path,
            volume: id.VolumeSerialNumber,
            id: id.FileId.Identifier,
            bytes: if directory { 0 } else { standard.EndOfFile },
            attributes: basic.FileAttributes,
            link_count: standard.NumberOfLinks,
            sha256: if directory {
                None
            } else {
                Some(native_sha256(handle)?.to_uppercase())
            },
            security: security_snapshot(handle, owner, policy)?,
        })
    }
    pub fn verify_held_snapshot(&self) -> Result<(), &'static str> {
        let path = self
            .snapshot
            .final_path
            .strip_prefix(r"\\?\")
            .ok_or("startup path prefix drift")?;
        if Self::snapshot(
            self.handle.raw(),
            path,
            self.directory,
            self.policy,
            &self.owner,
        )? != self.snapshot
        {
            return Err("startup same-handle pin drift");
        }
        Ok(())
    }
    pub fn verify(&self) -> Result<(), &'static str> {
        self.verify_held_snapshot()?;
        let path = self
            .snapshot
            .final_path
            .strip_prefix(r"\\?\")
            .ok_or("startup path prefix drift")?;
        // Same held object is not enough: prove that the pinned name still
        // resolves to it. Sharing + ancestor pins prevent ordinary replacement.
        let reopened = Self::open(path, self.directory, self.policy, &self.owner)?;
        if reopened.snapshot != self.snapshot {
            return Err("startup namespace pin drift");
        }
        Ok(())
    }
    /// Fixture-only construction for the production held-snapshot verification
    /// seam. It does NOT claim namespace-role admission and never changes parser
    /// paths or production open policy. Only retained task-private files qualify.
    #[cfg(test)]
    pub fn fixture_multilink_held_pin(path: &str, owner: &str) -> Result<Self, &'static str> {
        if !path.starts_with(
            r"C:\Neurobro\scratch\phase3-prestart-p-g2-native-fixtures-20260905\",
        ) {
            return Err("fixture held-pin root refused");
        }
        let handle = open_readonly_pinned_handle(path, false)?;
        let snapshot = Self::snapshot(handle.raw(), path, false, AclPolicy::FixedGit, owner)?;
        Ok(Self {
            handle,
            snapshot,
            directory: false,
            policy: AclPolicy::FixedGit,
            owner: owner.into(),
        })
    }
    pub fn require_binding(&self, bytes: u64, sha256: &str) -> Result<(), &'static str> {
        if self.directory
            || self.snapshot.bytes as u64 != bytes
            || self.snapshot.sha256.as_deref() != Some(sha256)
        {
            return Err("startup accepted file pin mismatch");
        }
        Ok(())
    }
    pub fn read_bounded(&self, max: usize) -> Result<Vec<u8>, &'static str> {
        if self.directory || self.snapshot.bytes <= 0 || self.snapshot.bytes as u64 > max as u64 {
            return Err("startup bounded size refused");
        }
        if unsafe { SetFilePointerEx(self.handle.raw(), 0, null_mut(), FILE_BEGIN) } == 0 {
            return Err("startup read seek failed");
        }
        let mut bytes = vec![0u8; self.snapshot.bytes as usize + 1];
        let mut total = 0;
        while total < bytes.len() {
            let mut read = 0;
            if unsafe {
                ReadFile(
                    self.handle.raw(),
                    bytes[total..].as_mut_ptr(),
                    (bytes.len() - total) as u32,
                    &mut read,
                    null_mut(),
                )
            } == 0
            {
                return Err("startup read failed");
            }
            if read == 0 {
                break;
            }
            total += read as usize;
        }
        if total != self.snapshot.bytes as usize {
            return Err("startup read length drift");
        }
        bytes.truncate(total);
        self.verify()?;
        Ok(bytes)
    }
}
