#![cfg(windows)]
#![allow(dead_code)]
#[path = "prestart-contract-vectors.rs"]
mod vectors;
use native::*;
use native_startup_files::*;
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use vectors::prestart::*;
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Security::Authorization::*;
use windows_sys::Win32::Security::*;
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::IO::DeviceIoControl;
use windows_sys::Win32::System::Ioctl::FSCTL_SET_REPARSE_POINT;
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcessToken, TerminateProcess, WaitForSingleObject,
};

const ROOT: &str =
    r"C:\Neurobro\scratch\phase3-prestart-p-g2-native-fixtures-20260905";
const NODE: &str = r"C:\Program Files\nodejs\node.exe";

fn protect(path: &Path, extra: &str) {
    assert!(path.starts_with(ROOT), "fixture ACL scope");
    let owner = process_owner_sid().unwrap();
    let sddl = format!(
        "O:{owner}D:P(A;OICI;FA;;;{owner})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FRFX;;;WD){extra}"
    );
    let mut descriptor = null_mut();
    assert_ne!(
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide(&sddl).as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        },
        0
    );
    let result = unsafe {
        SetFileSecurityW(
            wide(path.to_str().unwrap()).as_ptr(),
            OWNER_SECURITY_INFORMATION
                | DACL_SECURITY_INFORMATION
                | PROTECTED_DACL_SECURITY_INFORMATION,
            descriptor,
        )
    };
    unsafe {
        LocalFree(descriptor);
    }
    assert_ne!(
        result,
        0,
        "fixture SetFileSecurityW {}: {}",
        path.display(),
        unsafe { GetLastError() }
    );
}
fn protect_tree(path: &Path) {
    protect(path, "");
    if path.is_dir() {
        for item in std::fs::read_dir(path).unwrap() {
            protect_tree(&item.unwrap().path());
        }
    }
}
fn root(label: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = Path::new(ROOT).join(format!("{label}-{}-{stamp}", std::process::id()));
    std::fs::create_dir_all(&path).unwrap();
    path
}
fn bytes(path: &Path, content: &[u8]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
}
fn bind(path: &str) -> FileBinding {
    let content = std::fs::read(path).unwrap();
    FileBinding {
        path: path.into(),
        bytes: content.len() as u64,
        sha256: sha256(&content),
    }
}
fn writable_directory(path: &Path) -> Result<Handle, u32> {
    Handle::new(
        unsafe {
            CreateFileW(
                wide(path.to_str().unwrap()).as_ptr(),
                GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        },
        (),
    )
}
struct Revert;
impl Drop for Revert {
    fn drop(&mut self) {
        assert_ne!(unsafe { RevertToSelf() }, 0);
    }
}
fn restricted_writes(path: &Path, directory: &Path) {
    let mut token = null_mut();
    assert_ne!(
        unsafe {
            OpenProcessToken(
                GetCurrentProcess(),
                TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_IMPERSONATE,
                &mut token,
            )
        },
        0
    );
    let token = Handle::new(token, ()).unwrap();
    let mut everyone = null_mut();
    assert_ne!(
        unsafe { ConvertStringSidToSidW(wide("S-1-1-0").as_ptr(), &mut everyone) },
        0
    );
    let restricting = SID_AND_ATTRIBUTES {
        Sid: everyone,
        Attributes: 0,
    };
    let mut restricted = null_mut();
    let created = unsafe {
        CreateRestrictedToken(
            token.raw(),
            DISABLE_MAX_PRIVILEGE,
            0,
            null(),
            0,
            null(),
            1,
            &restricting,
            &mut restricted,
        )
    };
    unsafe {
        LocalFree(everyone);
    }
    assert_ne!(created, 0, "real restricted principal fixture");
    let restricted = Handle::new(restricted, ()).unwrap();
    assert_ne!(unsafe { ImpersonateLoggedOnUser(restricted.raw()) }, 0);
    let revert = Revert;
    let read = std::fs::read(path);
    let write = std::fs::write(path, b"ordinary restricted writer");
    let rename = std::fs::rename(path, directory.join("restricted-renamed.bin"));
    let delete = std::fs::remove_file(path);
    let create = std::fs::write(
        directory.join("restricted-created.bin"),
        b"ordinary restricted creator",
    );
    drop(revert);
    assert_eq!(
        delete.unwrap_err().raw_os_error(),
        Some(ERROR_ACCESS_DENIED as i32)
    );
    assert!(
        read.is_ok(),
        "restricted read exercises connected access seam: {read:?}"
    );
    assert_eq!(
        write.unwrap_err().raw_os_error(),
        Some(ERROR_ACCESS_DENIED as i32)
    );
    assert_eq!(
        rename.unwrap_err().raw_os_error(),
        Some(ERROR_ACCESS_DENIED as i32)
    );
    assert_eq!(
        create.unwrap_err().raw_os_error(),
        Some(ERROR_ACCESS_DENIED as i32)
    );
}
fn fixture(label: &str, entry: &str) -> (PathBuf, String, StartupBinding) {
    let dir = root(label);
    let mut binding = vectors::sample(dir.to_str().unwrap());
    binding.acceptance_id = format!("{:08x}-1111-4111-8111-111111111111", std::process::id());
    for path in [
        &binding.native_prestart.path,
        &binding.launcher.path,
        &binding.observer.path,
    ] {
        bytes(Path::new(path), b"inert file pin; never executed");
    }
    bytes(Path::new(&binding.live_entry.path), entry.as_bytes());
    bytes(
        Path::new(&binding.carrier.path),
        b"inert carrier pin; not a product carrier",
    );
    std::fs::copy(NODE, &binding.node.path).unwrap();
    bytes(
        Path::new(&binding.binary_bindings.runner.path),
        &vec![0x5a; 1_446_912],
    );
    binding.binary_bindings.runner = bind(&binding.binary_bindings.runner.path);
    // Fixed OS/vendor inputs are read/pinned, never executed or reconfigured.
    binding.binary_bindings.git = bind(FIXED_GIT);
    binding.binary_bindings.wsl = bind(FIXED_WSL);
    binding.native_prestart = bind(&binding.native_prestart.path);
    binding.launcher = bind(&binding.launcher.path);
    binding.observer = bind(&binding.observer.path);
    binding.live_entry = bind(&binding.live_entry.path);
    binding.carrier = bind(&binding.carrier.path);
    let node = bind(&binding.node.path);
    binding.node.bytes = node.bytes;
    binding.node.sha256 = node.sha256;
    let binding_path = dir
        .join("startup-trust-v1")
        .join("accepted-launchbinding-v1.json");
    bytes(&binding_path, &canonical_bytes(&binding));
    protect_tree(&dir);
    (dir, binding_path.to_str().unwrap().into(), binding)
}

#[test]
fn large_streaming_pin_and_hardlink_alias_sharing() {
    let dir = root("large-binary-alias");
    let file = dir.join("large.exe");
    let alias = dir.join("same-inode-alias.exe");
    let content = vec![0x7bu8; 1_446_912];
    bytes(&file, &content);
    protect_tree(&dir);
    let owner = process_owner_sid().unwrap();
    let pin = Pin::open(file.to_str().unwrap(), false, AclPolicy::Startup, &owner).unwrap();
    pin.require_binding(content.len() as u64, &sha256(&content))
        .unwrap();
    assert!(
        pin.require_binding(content.len() as u64 - 1, &sha256(&content))
            .is_err()
    );
    assert!(
        pin.require_binding(content.len() as u64, &"0".repeat(64))
            .is_err()
    );
    assert!(std::fs::write(&file, b"changed").is_err());
    assert!(std::fs::rename(&file, &alias).is_err());
    pin.verify().unwrap();
    drop(pin);
    // The same production open primitive excludes data mutation via ANY alias.
    // Alternate-name deletion is an ACL boundary, not a sharing-only claim.
    std::fs::hard_link(&file, &alias).unwrap();
    let snapshot_pin = Pin::fixture_multilink_held_pin(file.to_str().unwrap(), &owner).unwrap();
    snapshot_pin.verify_held_snapshot().unwrap();
    let held = open_readonly_pinned_handle(file.to_str().unwrap(), false).unwrap();
    let before: FILE_STANDARD_INFO = native_file_info(held.raw(), FileStandardInfo).unwrap();
    assert_eq!(before.NumberOfLinks, 2);
    let before_id: FILE_ID_INFO = native_file_info(held.raw(), FileIdInfo).unwrap();
    let before_security = security_snapshot(held.raw(), &owner, AclPolicy::FixedGit).unwrap();
    assert_eq!(
        security_snapshot(held.raw(), &owner, AclPolicy::FixedWsl).unwrap(),
        before_security
    );
    restricted_writes(&alias, &dir);
    assert_eq!(
        std::fs::write(&alias, b"alias mutation")
            .unwrap_err()
            .raw_os_error(),
        Some(ERROR_SHARING_VIOLATION as i32)
    );
    // Trusted owner can delete another name: the changed count is reobserved.
    std::fs::remove_file(&alias).unwrap();
    assert!(
        snapshot_pin.verify_held_snapshot().is_err(),
        "actual count drift must refuse the production held-snapshot seam"
    );
    let after: FILE_STANDARD_INFO = native_file_info(held.raw(), FileStandardInfo).unwrap();
    let after_id: FILE_ID_INFO = native_file_info(held.raw(), FileIdInfo).unwrap();
    assert_eq!(after.NumberOfLinks, 1);
    assert_ne!(after.NumberOfLinks, before.NumberOfLinks);
    assert_eq!(after_id.VolumeSerialNumber, before_id.VolumeSerialNumber);
    assert_eq!(after_id.FileId.Identifier, before_id.FileId.Identifier);
    assert_eq!(
        security_snapshot(held.raw(), &owner, AclPolicy::FixedGit).unwrap(),
        before_security
    );
    assert_eq!(
        native_sha256(held.raw()).unwrap().to_uppercase(),
        sha256(&content)
    );
    drop(held);
    drop(snapshot_pin);
    // Positive control changes actual alias bytes once sharing is released.
    std::fs::hard_link(&file, &alias).unwrap();
    std::fs::write(&alias, b"distinct replacement bytes after release").unwrap();
    assert_eq!(
        std::fs::read(&file).unwrap(),
        b"distinct replacement bytes after release"
    );
    assert!(Pin::open(file.to_str().unwrap(), false, AclPolicy::Startup, &owner).is_err());
    assert!(Pin::open(file.to_str().unwrap(), false, AclPolicy::FixedGit, &owner).is_err());
    assert!(Pin::open(file.to_str().unwrap(), false, AclPolicy::FixedWsl, &owner).is_err());
    protect(&file, "(A;;FW;;;WD)");
    let held = open_readonly_pinned_handle(file.to_str().unwrap(), false).unwrap();
    assert!(security_snapshot(held.raw(), &owner, AclPolicy::FixedGit).is_err());
    assert!(security_snapshot(held.raw(), &owner, AclPolicy::FixedWsl).is_err());
}

#[test]
fn actual_fixed_vendor_file_pins_read_only() {
    let owner = process_owner_sid().unwrap();
    let mut pins = Vec::new();
    for path in [
        r"C:\Windows",
        r"C:\Windows\System32",
        r"C:\Program Files",
        r"C:\Program Files\WSL",
        r"C:\Program Files\Git",
        r"C:\Program Files\Git\mingw64",
        r"C:\Program Files\Git\mingw64\bin",
    ] {
        let policy = fixed_external_policy(path, true).unwrap();
        pins.push(
            Pin::open(path, true, policy, &owner)
                .unwrap_or_else(|e| panic!("fixed ancestor {path}: {e}")),
        );
    }
    for (path, expected_bytes, expected_sha) in [
        (
            FIXED_WSL,
            4_248_608,
            "7577D6257A3C1E3E914155DC6EBC8F4F1C4C94B093DE100CEC01CD8A0E57ACD7",
        ),
        (
            FIXED_GIT,
            4_422_544,
            "CAB4C4EEA1D869CF9F7BE73868DC9A90AD2DF1B1B673E5F8C8714A576C25EA96",
        ),
    ] {
        let policy = fixed_external_policy(path, false).unwrap();
        let pin = Pin::open(path, false, policy, &owner)
            .unwrap_or_else(|e| panic!("fixed file {path}: {e}"));
        assert_eq!(pin.snapshot.bytes, expected_bytes);
        assert_eq!(pin.snapshot.sha256.as_deref(), Some(expected_sha));
        assert!(pin.snapshot.link_count >= 1);
        pins.push(pin);
    }
    for pin in &pins {
        pin.verify().unwrap();
    }
    assert!(Pin::open(FIXED_GIT, false, AclPolicy::FixedWindows, &owner).is_err());
    assert!(Pin::open(FIXED_WSL, false, AclPolicy::FixedWindows, &owner).is_err());
    assert!(Pin::open(FIXED_WSL, false, AclPolicy::FixedGit, &owner).is_err());
    assert!(Pin::open(FIXED_GIT, false, AclPolicy::FixedWsl, &owner).is_err());
    assert!(Pin::open(r"C:\Program Files\WSL", true, AclPolicy::FixedWindows, &owner).is_err());
    assert!(Pin::open(r"C:\Program Files\Git", true, AclPolicy::FixedWsl, &owner).is_err());
    assert!(fixed_external_policy(r"C:\Windows\System32\wsl.exe", false).is_none());
    assert!(fixed_external_policy(r"C:\Windows\System32\other.exe", false).is_none());
}

#[test]
fn actual_sharing_namespace_reparse_hardlink_and_acl() {
    let dir = root("files");
    let file = dir.join("pinned.bin");
    bytes(&file, b"pinned original bytes");
    protect_tree(&dir);
    let owner = process_owner_sid().unwrap();
    let previous_file_writer = std::fs::OpenOptions::new().write(true).open(&file).unwrap();
    assert!(Pin::open(file.to_str().unwrap(), false, AclPolicy::Startup, &owner).is_err());
    drop(previous_file_writer);
    // Actual preexisting writable directory handle must prevent pin admission.
    let previous_writer = writable_directory(&dir).unwrap();
    assert!(Pin::open(dir.to_str().unwrap(), true, AclPolicy::Startup, &owner).is_err());
    drop(previous_writer);
    let directory_pin = Pin::open(dir.to_str().unwrap(), true, AclPolicy::Startup, &owner).unwrap();
    assert_eq!(
        writable_directory(&dir).unwrap_err(),
        ERROR_SHARING_VIOLATION
    );
    let pin = Pin::open(file.to_str().unwrap(), false, AclPolicy::Startup, &owner).unwrap();
    assert!(std::fs::write(&file, b"different").is_err());
    assert!(std::fs::rename(&file, dir.join("replacement.bin")).is_err());
    assert!(std::fs::rename(&dir, dir.with_extension("renamed")).is_err());
    // A directory pin is not a blanket child-write lock.
    bytes(&dir.join("unrelated.txt"), b"benign unrelated child");
    pin.verify().unwrap();
    directory_pin.verify().unwrap();
    drop(pin);
    drop(directory_pin);
    // With no pins, the ACL independently rejects a real restricted token's
    // write, rename and child creation, while permitting its read.
    restricted_writes(&file, &dir);
    std::fs::write(&file, b"changed after release").unwrap();
    std::fs::hard_link(&file, dir.join("second-link.bin")).unwrap();
    assert!(Pin::open(file.to_str().unwrap(), false, AclPolicy::Startup, &owner).is_err());
    let bad = dir.join("ordinary-writable.bin");
    bytes(&bad, b"bad policy");
    protect(&bad, "(A;;FW;;;WD)");
    assert!(Pin::open(bad.to_str().unwrap(), false, AclPolicy::Startup, &owner).is_err());
    let link = dir.join("reparse.bin");
    // A real symbolic link, not a mocked metadata claim. Developer-mode or
    // symlink privilege is an explicit test prerequisite; failure is not skip.
    std::os::windows::fs::symlink_file(&bad, &link)
        .expect("real task-private symlink fixture required");
    assert!(Pin::open(link.to_str().unwrap(), false, AclPolicy::Startup, &owner).is_err());
    eprintln!("retained native fixture {}", dir.display());
}

#[test]
fn real_directory_reparse_mutation_is_excluded_by_pin_access() {
    let dir = root("reparse-mutation");
    let destination = dir.join("destination");
    let victim = dir.join("pinned-directory");
    let positive = dir.join("writable-control");
    for path in [&destination, &victim, &positive] {
        std::fs::create_dir(path).unwrap();
    }
    protect_tree(&dir);
    // An actual mount-point reparse buffer needs no symlink privilege. Reuse
    // identical bytes for the denied pin and successful writable control.
    let substitute = format!(r"\??\{}", destination.display());
    let display = destination.to_str().unwrap();
    let substitute: Vec<u16> = substitute.encode_utf16().collect();
    let display: Vec<u16> = display.encode_utf16().collect();
    let data_length = 8 + (substitute.len() + display.len() + 2) * 2;
    let mut buffer = Vec::new();
    buffer.extend(0xa0000003u32.to_le_bytes());
    buffer.extend((data_length as u16).to_le_bytes());
    buffer.extend(0u16.to_le_bytes());
    buffer.extend(0u16.to_le_bytes());
    buffer.extend((substitute.len() as u16 * 2).to_le_bytes());
    buffer.extend(((substitute.len() as u16 + 1) * 2).to_le_bytes());
    buffer.extend((display.len() as u16 * 2).to_le_bytes());
    for unit in substitute
        .into_iter()
        .chain(Some(0))
        .chain(display)
        .chain(Some(0))
    {
        buffer.extend(unit.to_le_bytes());
    }
    let mut returned = 0;
    let owner = process_owner_sid().unwrap();
    let pin = Pin::open(victim.to_str().unwrap(), true, AclPolicy::Startup, &owner).unwrap();
    let changed = unsafe {
        DeviceIoControl(
            pin.handle.raw(),
            FSCTL_SET_REPARSE_POINT,
            buffer.as_ptr().cast(),
            buffer.len() as u32,
            null_mut(),
            0,
            &mut returned,
            null_mut(),
        )
    };
    assert_eq!(changed, 0);
    assert_eq!(unsafe { GetLastError() }, ERROR_ACCESS_DENIED);
    pin.verify().unwrap();
    let writable = writable_directory(&positive).unwrap();
    assert_ne!(
        unsafe {
            DeviceIoControl(
                writable.raw(),
                FSCTL_SET_REPARSE_POINT,
                buffer.as_ptr().cast(),
                buffer.len() as u32,
                null_mut(),
                0,
                &mut returned,
                null_mut(),
            )
        },
        0,
        "same actual reparse buffer must mutate writable positive control: {}",
        unsafe { GetLastError() }
    );
    drop(writable);
    assert!(Pin::open(positive.to_str().unwrap(), true, AclPolicy::Startup, &owner).is_err());
    eprintln!("retained native fixture {}", dir.display());
}

#[test]
fn real_node_suspended_constructed_launch_and_no_retry() {
    let entry = r#"import {writeFileSync} from 'node:fs'; writeFileSync('child-readback.json', JSON.stringify({argv:process.argv,execArgv:process.execArgv,cwd:process.cwd(),env:process.env,version:process.version}));"#;
    let (dir, binding_path, binding) = fixture("launch", entry);
    let prepared = prepare_fixture(&binding_path, &binding.native_prestart.path).unwrap();
    let readback = dir.join("child-readback.json");
    let mut stages = Vec::new();
    let result = launch_observed(prepared, |stage, pins| {
        stages.push(stage);
        if stage == Stage::Suspended || stage == Stage::BeforeResume {
            assert!(!readback.exists(), "Node evaluated before resume");
        }
        if stage == Stage::KnownExit {
            assert!(
                std::fs::write(&binding.live_entry.path, b"post-consumption mutation").is_err()
            );
            pins.verify()?;
        }
        Ok(())
    })
    .unwrap();
    assert_eq!(result, Outcome::KnownExit(0));
    assert_eq!(
        stages,
        vec![
            Stage::BeforeCreate,
            Stage::Suspended,
            Stage::BeforeResume,
            Stage::Resumed,
            Stage::KnownExit
        ]
    );
    let observed: serde_json::Value =
        serde_json::from_slice(&std::fs::read(readback).unwrap()).unwrap();
    assert_eq!(
        observed["argv"],
        serde_json::json!([binding.node.path, binding.live_entry.path])
    );
    assert_eq!(observed["execArgv"], serde_json::json!([]));
    assert_eq!(observed["cwd"], binding.cwd);
    assert_eq!(observed["version"], "v24.15.0");
    assert_eq!(
        observed["env"],
        serde_json::json!({"SystemRoot":"C:\\Windows","WINDIR":"C:\\Windows"})
    );
    let replay = prepare_fixture(&binding_path, &binding.native_prestart.path).unwrap();
    assert!(launch(replay).unwrap_err().contains("no retry"));
    eprintln!("retained native fixture {}", dir.display());
}

#[test]
fn connected_precreate_and_preresume_poison() {
    let (dir, binding_path, binding) = fixture(
        "poison",
        "import {writeFileSync} from 'node:fs'; writeFileSync('forbidden-marker','bad');",
    );
    // Changed hostile bytes exercise actual hash validation before CreateProcess.
    std::fs::write(
        &binding.live_entry.path,
        b"actual changed hostile entry bytes",
    )
    .unwrap();
    assert!(prepare_fixture(&binding_path, &binding.native_prestart.path).is_err());
    assert!(!dir.join("forbidden-marker").exists());
    let (dir, binding_path, binding) = fixture(
        "suspended-poison",
        "import {writeFileSync} from 'node:fs'; writeFileSync('forbidden-marker','bad');",
    );
    let prepared = prepare_fixture(&binding_path, &binding.native_prestart.path).unwrap();
    let mut suspended = false;
    let result = launch_observed(prepared, |stage, _| {
        if stage == Stage::BeforeResume {
            suspended = true;
            // Owner can change ACL; real policy bytes must be noticed before
            // resume, even though the file's data/hash remains unchanged.
            protect(Path::new(&binding.live_entry.path), "(A;;FW;;;WD)");
        }
        Ok(())
    })
    .unwrap();
    assert!(suspended);
    assert_eq!(result, Outcome::KnownStopped);
    assert!(!dir.join("forbidden-marker").exists());
    eprintln!("retained native fixture {}", dir.display());
}

#[test]
fn connected_unknown_retains_pins_attempt_and_partial_process_handles() {
    for fault in [
        FixtureFault::MalformedCreate,
        FixtureFault::WaitFailed,
        FixtureFault::TerminateFailed,
    ] {
        let (dir, binding_path, binding) = fixture("unknown", "setTimeout(() => {}, 1000);");
        let prepared = prepare_fixture(&binding_path, &binding.native_prestart.path).unwrap();
        let observed = launch_fixture_fault(prepared, fault).unwrap();
        assert_eq!(
            observed.outcome,
            Outcome::UnknownRetained,
            "fault {fault:?}"
        );
        // These actual sharing checks fail if unknown() drops Prepared/Attempt.
        for path in [&binding_path, &binding.live_entry.path, &binding.node.path] {
            assert_eq!(
                std::fs::OpenOptions::new()
                    .write(true)
                    .open(path)
                    .unwrap_err()
                    .raw_os_error(),
                Some(ERROR_SHARING_VIOLATION as i32)
            );
        }
        let attempt = Path::new(&binding_path)
            .parent()
            .unwrap()
            .join(format!("attempt-{}.jsonl", binding.acceptance_id));
        assert_eq!(
            std::fs::OpenOptions::new()
                .write(true)
                .open(&attempt)
                .unwrap_err()
                .raw_os_error(),
            Some(ERROR_SHARING_VIOLATION as i32)
        );
        let mut flags = 0;
        assert_ne!(
            unsafe { GetHandleInformation(observed.original_thread as HANDLE, &mut flags) },
            0,
            "partial thread handle was dropped"
        );
        if fault == FixtureFault::MalformedCreate {
            assert_ne!(
                unsafe { GetHandleInformation(observed.original_process as HANDLE, &mut flags) },
                0,
                "partial process handle was dropped"
            );
        }
        let replay = prepare_fixture(&binding_path, &binding.native_prestart.path).unwrap();
        assert!(launch(replay).unwrap_err().contains("no retry"));
        let record = std::fs::read_to_string(&attempt).unwrap();
        assert!(record.contains("\"outcome\":\"unknown\""));
        assert!(!record.contains("known-exit") && !record.contains("known-stopped"));
        // Test controller reconciliation is separate from the runtime's UNKNOWN:
        // no retry, record rewrite, or release is performed by the prestart path.
        if fault == FixtureFault::WaitFailed {
            assert_eq!(
                unsafe { WaitForSingleObject(observed.keeper.raw(), 5000) },
                WAIT_OBJECT_0
            );
        } else {
            assert_ne!(
                unsafe { TerminateProcess(observed.keeper.raw(), 0xE003_21F0) },
                0
            );
            assert_eq!(
                unsafe { WaitForSingleObject(observed.keeper.raw(), 5000) },
                WAIT_OBJECT_0
            );
        }
        assert!(
            std::fs::OpenOptions::new()
                .write(true)
                .open(&binding.live_entry.path)
                .is_err(),
            "reconciliation must not silently drop retained pins"
        );
        eprintln!(
            "retained native UNKNOWN fixture {} fault={fault:?}",
            dir.display()
        );
    }
}
