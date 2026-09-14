//! Fixed-file native prestart. Trust is owner-controlled startup plus Windows,
//! not native-origin authentication or mapped-image byte measurement.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const BINDING_PATH: &str =
    r"C:\ProgramData\DecadansNeurobro\startup-trust-v1\accepted-launchbinding-v1.json";
pub const SCHEMA: &str = "decadans.rm0032.accepted-startup-launchbinding.v2";
// Execute the engine directly: the cmd wrapper needs another Job process.
pub const FIXED_GIT: &str = r"C:\Program Files\Git\mingw64\bin\git.exe";
// The installed WSL CLI avoids the System32 forwarder refused by Job1.
pub const FIXED_WSL: &str = r"C:\Program Files\WSL\wsl.exe";
pub const ACCEPTED_C1: &str = "dad22e37dc12da1ffbf3f1cdf961db6e49da305d";
pub const MAX_BINDING_BYTES: usize = 65_536;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileBinding {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeBinding {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    pub version: String,
    pub platform: String,
    pub arch: String,
}
impl NodeBinding {
    pub fn file(&self) -> FileBinding {
        FileBinding {
            path: self.path.clone(),
            bytes: self.bytes,
            sha256: self.sha256.clone(),
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitTuple {
    pub commit: String,
    pub tree: String,
    pub parent: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CarrierTuple {
    pub commit: String,
    pub tree: String,
    pub parent: String,
    pub carrier_blob_id: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcceptedGeneration {
    pub p: GitTuple,
    pub a: GitTuple,
    pub k: CarrierTuple,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartupBinding {
    pub schema: String,
    pub acceptance_id: String,
    pub accepted_generation: AcceptedGeneration,
    pub repository_root: String,
    pub cwd: String,
    pub native_prestart: FileBinding,
    pub node: NodeBinding,
    pub live_entry: FileBinding,
    pub carrier: FileBinding,
    pub launcher: FileBinding,
    pub observer: FileBinding,
    pub binary_bindings: BinaryBindings,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BinaryBindings {
    pub runner: FileBinding,
    pub git: FileBinding,
    pub wsl: FileBinding,
}
pub fn sha256(bytes: &[u8]) -> String {
    format!("{:X}", Sha256::digest(bytes))
}
fn hex(value: &str, count: usize, upper: bool) -> bool {
    value.len() == count
        && value.bytes().all(|b| {
            b.is_ascii_digit()
                || if upper {
                    (b'A'..=b'F').contains(&b)
                } else {
                    (b'a'..=b'f').contains(&b)
                }
        })
}
fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.as_bytes()[14] == b'4'
        && matches!(value.as_bytes()[19], b'8' | b'9' | b'a' | b'b')
        && value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}
pub fn canonical_path(path: &str) -> bool {
    let b = path.as_bytes();
    b.len() > 3
        && b[0].is_ascii_uppercase()
        && b[1] == b':'
        && b[2] == b'\\'
        && !path[3..].contains(['/', ':', '"', '<', '>', '|', '?', '*'])
        && !path.chars().any(|c| c.is_control())
        && path[3..]
            .split('\\')
            .all(|p| !p.is_empty() && p != "." && p != ".." && !p.ends_with([' ', '.']))
}
fn check_file(file: &FileBinding) -> Result<(), &'static str> {
    if !canonical_path(&file.path)
        || file.bytes == 0
        || file.bytes > MAX_SAFE_INTEGER
        || !hex(&file.sha256, 64, true)
    {
        return Err("startup file binding refused");
    }
    Ok(())
}
pub fn canonical_bytes(binding: &StartupBinding) -> Vec<u8> {
    // serde_json's default Map uses lexically sorted keys, shared with the
    // runtime contract's recursive sorted-key canonical JSON.
    serde_json::to_vec(&serde_json::to_value(binding).expect("binding serializes"))
        .expect("value serializes")
}
pub fn parse_binding(bytes: &[u8]) -> Result<StartupBinding, &'static str> {
    if bytes.is_empty() || bytes.len() > MAX_BINDING_BYTES || bytes.starts_with(&[0xef, 0xbb, 0xbf])
    {
        return Err("startup binding length/BOM refused");
    }
    if std::str::from_utf8(bytes)
        .map_err(|_| "startup UTF-8 refused")?
        .contains('\u{feff}')
    {
        return Err("startup BOM scalar refused");
    }
    let binding: StartupBinding =
        serde_json::from_slice(bytes).map_err(|_| "startup binding closed JSON refused")?;
    if canonical_bytes(&binding) != bytes {
        return Err("startup binding canonical bytes refused");
    }
    if binding.schema != SCHEMA || !uuid(&binding.acceptance_id) {
        return Err("startup schema/acceptance refused");
    }
    if !canonical_path(&binding.repository_root) || binding.cwd != binding.repository_root {
        return Err("startup root/cwd refused");
    }
    let generation = &binding.accepted_generation;
    for value in [
        &generation.p.commit,
        &generation.p.tree,
        &generation.p.parent,
        &generation.a.commit,
        &generation.a.tree,
        &generation.a.parent,
        &generation.k.commit,
        &generation.k.tree,
        &generation.k.parent,
        &generation.k.carrier_blob_id,
    ] {
        if !hex(value, 40, false) {
            return Err("startup Git tuple refused");
        }
    }
    if generation.p.parent != ACCEPTED_C1
        || generation.a.parent != generation.p.commit
        || generation.k.parent != generation.a.commit
        || generation.p.commit == generation.a.commit
        || generation.p.commit == generation.k.commit
        || generation.a.commit == generation.k.commit
        || [
            &generation.p.commit,
            &generation.a.commit,
            &generation.k.commit,
        ]
        .contains(&&ACCEPTED_C1.to_string())
    {
        return Err("startup accepted generation chain refused");
    }
    let files = [
        &binding.native_prestart,
        &binding.live_entry,
        &binding.carrier,
        &binding.launcher,
        &binding.observer,
        &binding.binary_bindings.runner,
        &binding.binary_bindings.git,
        &binding.binary_bindings.wsl,
    ];
    for file in files {
        check_file(file)?;
    }
    check_file(&binding.node.file())?;
    if !binding
        .binary_bindings
        .runner
        .path
        .to_ascii_lowercase()
        .ends_with(".exe")
        || binding.binary_bindings.git.path != FIXED_GIT
        || binding.binary_bindings.wsl.path != FIXED_WSL
    {
        return Err("startup fixed binary path refused");
    }
    if binding.node.path.rsplit('\\').next() != Some("node.exe") {
        return Err("startup Node basename refused");
    }
    if binding.node.version != "v24.15.0"
        || binding.node.platform != "win32"
        || binding.node.arch != "x64"
    {
        return Err("startup runtime refused");
    }
    if binding.live_entry.path
        != format!(
            r"{}\packages\rm0032-phase3-runner\src\phase3-hardening-live-entry.mjs",
            binding.repository_root
        )
        || binding.carrier.path
            != format!(
                r"{}\project\verification\rm-0032-phase3-live-hardening-carrier.json",
                binding.repository_root
            )
    {
        return Err("startup derived path refused");
    }
    let mut paths: Vec<String> = files.iter().map(|f| f.path.to_uppercase()).collect();
    paths.push(binding.node.path.to_uppercase());
    paths.sort_unstable();
    paths.dedup();
    if paths.len() != 9 || paths.contains(&BINDING_PATH.to_uppercase()) {
        return Err("startup aliased file bindings refused");
    }
    Ok(binding)
}

#[cfg(windows)]
#[path = "../native_startup_files.rs"]
pub mod native_startup_files;

#[cfg(windows)]
pub mod native {
    use super::native_startup_files::*;
    use super::*;
    use std::collections::BTreeSet;
    use std::mem::{size_of, zeroed};
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::Storage::FileSystem::*;
    use windows_sys::Win32::System::Threading::*;

    pub struct Prepared {
        pub binding: StartupBinding,
        pub binding_bytes: Vec<u8>,
        pub files: Vec<Pin>,
        pub directories: Vec<Pin>,
        pub owner: String,
        pub binding_path: String,
    }
    fn parent(path: &str) -> Result<&str, &'static str> {
        path.rsplit_once('\\')
            .map(|v| v.0)
            .filter(|p| p.len() > 2)
            .ok_or("startup parent absent")
    }
    fn ancestors(path: &str) -> Result<Vec<String>, &'static str> {
        if !canonical_path(path) {
            return Err("startup ancestor path refused");
        }
        let mut result = vec![path[..3].into()];
        for (i, b) in path.bytes().enumerate() {
            if b == b'\\' && i > 2 {
                result.push(path[..i].into());
            }
        }
        Ok(result)
    }
    fn pin_ancestors(
        paths: &[&str],
        strict_roots: &[&str],
        owner: &str,
    ) -> Result<Vec<Pin>, &'static str> {
        let mut all = BTreeSet::new();
        for path in paths {
            all.extend(ancestors(path)?);
        }
        let mut result = Vec::new();
        for path in all {
            let strict = strict_roots
                .iter()
                .any(|root| path == *root || path.starts_with(&format!(r"{root}\")));
            result.push(Pin::open(
                &path,
                true,
                if path.len() == 3 {
                    AclPolicy::VolumeRoot
                } else if let Some(policy) = fixed_external_policy(&path, true) {
                    policy
                } else if strict {
                    AclPolicy::Startup
                } else {
                    AclPolicy::SharedAncestor
                },
                owner,
            )?);
        }
        Ok(result)
    }
    impl Prepared {
        pub fn verify(&self) -> Result<(), &'static str> {
            for pin in &self.directories {
                pin.verify()?;
            }
            for pin in &self.files {
                pin.verify()?;
            }
            Ok(())
        }
    }
    fn prepare_at(binding_path: &str, expected_self_path: &str) -> Result<Prepared, &'static str> {
        let owner = process_owner_sid()?;
        let mut directories = pin_ancestors(&[binding_path], &[parent(binding_path)?], &owner)?;
        let binding_pin = Pin::open(binding_path, false, AclPolicy::Startup, &owner)?;
        let binding_bytes = binding_pin.read_bounded(MAX_BINDING_BYTES)?;
        let binding = parse_binding(&binding_bytes)?;
        if binding.native_prestart.path != expected_self_path {
            return Err("startup native self path refused");
        }
        for (path, basename) in [
            (&binding.native_prestart.path, "phase3-prestart-v1.exe"),
            (&binding.node.path, "node.exe"),
            (
                &binding.launcher.path,
                "rm0032-phase3-native-observer-launcher-v1.exe",
            ),
            (
                &binding.observer.path,
                "rm0032-phase3-native-observer-v1.exe",
            ),
        ] {
            if path.rsplit('\\').next() != Some(basename) {
                return Err("startup executable basename refused");
            }
        }
        let node = binding.node.file();
        let file_bindings = [
            &binding.native_prestart,
            &node,
            &binding.live_entry,
            &binding.carrier,
            &binding.launcher,
            &binding.observer,
            &binding.binary_bindings.runner,
            &binding.binary_bindings.git,
            &binding.binary_bindings.wsl,
        ];
        let mut paths: Vec<&str> = file_bindings.iter().map(|f| f.path.as_str()).collect();
        // Include cwd itself by giving its synthetic child to the ancestor walk.
        let cwd_child = format!(r"{}\__namespace_pin_only__", binding.cwd);
        paths.push(&cwd_child);
        let mut strict_roots: Vec<&str> = file_bindings
            .iter()
            .map(|f| parent(&f.path))
            .collect::<Result<_, _>>()?;
        strict_roots.push(&binding.repository_root);
        directories.extend(pin_ancestors(&paths, &strict_roots, &owner)?);
        let mut files = vec![binding_pin];
        for file in file_bindings {
            let policy = fixed_external_policy(&file.path, false).unwrap_or(AclPolicy::Startup);
            let pin = Pin::open(&file.path, false, policy, &owner)?;
            pin.require_binding(file.bytes, &file.sha256)?;
            files.push(pin);
        }
        let prepared = Prepared {
            binding,
            binding_bytes,
            files,
            directories,
            owner,
            binding_path: binding_path.into(),
        };
        prepared.verify()?;
        Ok(prepared)
    }
    pub fn prepare_production() -> Result<Prepared, &'static str> {
        if std::env::args_os().count() != 1 {
            return Err("startup arguments refused");
        }
        let own_path = std::env::current_exe().map_err(|_| "startup self path unavailable")?;
        let own_path = own_path
            .to_str()
            .ok_or("startup self path UTF-16 refused")?;
        let own_path = own_path.strip_prefix(r"\\?\").unwrap_or(own_path);
        prepare_at(BINDING_PATH, own_path)
    }
    #[cfg(test)]
    pub fn prepare_fixture(
        binding_path: &str,
        expected_self_path: &str,
    ) -> Result<Prepared, &'static str> {
        const ROOT: &str =
            r"C:\Neurobro\scratch\phase3-prestart-p-g2-native-fixtures-20260905\";
        if !binding_path.starts_with(ROOT) || !expected_self_path.starts_with(ROOT) {
            return Err("fixture root refused");
        }
        prepare_at(binding_path, expected_self_path)
    }
    pub fn command_line(binding: &StartupBinding) -> String {
        format!("\"{}\" \"{}\"", binding.node.path, binding.live_entry.path)
    }
    pub fn environment() -> Vec<u16> {
        "SystemRoot=C:\\Windows\0WINDIR=C:\\Windows\0\0"
            .encode_utf16()
            .collect()
    }

    /// CREATE_NEW is the minimal one-shot guard: it survives process death and
    /// is never removed/reused here. An unrecorded completion remains unknown.
    struct Attempt {
        handle: Handle,
    }
    fn write_all(handle: HANDLE, bytes: &[u8]) -> Result<(), &'static str> {
        let mut offset = 0;
        while offset < bytes.len() {
            let mut count = 0;
            if unsafe {
                WriteFile(
                    handle,
                    bytes[offset..].as_ptr(),
                    (bytes.len() - offset) as u32,
                    &mut count,
                    null_mut(),
                )
            } == 0
                || count == 0
            {
                return Err("startup attempt write unknown");
            }
            offset += count as usize;
        }
        if unsafe { FlushFileBuffers(handle) } == 0 {
            return Err("startup attempt flush unknown");
        }
        Ok(())
    }
    impl Attempt {
        fn create(prepared: &Prepared) -> Result<Self, &'static str> {
            let path = format!(
                r"{}\attempt-{}.jsonl",
                parent(&prepared.binding_path)?,
                prepared.binding.acceptance_id
            );
            let handle = Handle::new(
                unsafe {
                    CreateFileW(
                        wide(&path).as_ptr(),
                        FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL,
                        FILE_SHARE_READ,
                        null(),
                        CREATE_NEW,
                        FILE_ATTRIBUTE_NORMAL
                            | FILE_FLAG_OPEN_REPARSE_POINT
                            | FILE_FLAG_WRITE_THROUGH,
                        null_mut(),
                    )
                },
                (),
            )
            .map_err(|_| "startup attempt already exists or creation refused; no retry")?;
            // Parent namespace is already held and protected. Observe the new
            // object's inherited ACL before dispatch; never provision host ACLs.
            security_snapshot(handle.raw(), &prepared.owner, AclPolicy::InheritedAttempt)?;
            let bytes = format!(
                "{{\"acceptanceId\":\"{}\",\"bindingSha256\":\"{}\",\"outcome\":\"unknown\"}}\n",
                prepared.binding.acceptance_id,
                sha256(&prepared.binding_bytes)
            );
            write_all(handle.raw(), bytes.as_bytes())?;
            Ok(Self { handle })
        }
        fn record(&self, result: &str, pid: u32) -> Result<(), &'static str> {
            write_all(
                self.handle.raw(),
                format!("{{\"outcome\":\"{result}\",\"pid\":{pid}}}\n").as_bytes(),
            )
        }
    }
    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub enum Stage {
        BeforeCreate,
        Suspended,
        BeforeResume,
        Resumed,
        KnownExit,
    }
    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub enum Outcome {
        KnownExit(u32),
        NeverStarted,
        KnownStopped,
        UnknownRetained,
    }
    // Fault results are available only in test builds and only through an
    // entry point requiring the exact task-private fixture root. Real child
    // creation/handles/pins still exercise the production decision path.
    #[cfg(test)]
    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub enum FixtureFault {
        MalformedCreate,
        WaitFailed,
        TerminateFailed,
    }
    #[cfg(test)]
    std::thread_local! {
        static FIXTURE_FAULT: std::cell::Cell<Option<FixtureFault>> = const { std::cell::Cell::new(None) };
        static FIXTURE_KEEPER: std::cell::RefCell<Option<Handle>> = const { std::cell::RefCell::new(None) };
        static FIXTURE_RAW_HANDLES: std::cell::Cell<(usize, usize)> = const { std::cell::Cell::new((0, 0)) };
    }
    #[cfg(test)]
    fn fault_is(fault: FixtureFault) -> bool {
        FIXTURE_FAULT.with(|v| v.get() == Some(fault))
    }
    #[cfg(test)]
    fn capture_fixture_child(pi: &PROCESS_INFORMATION) {
        if FIXTURE_FAULT.with(|v| v.get().is_none()) {
            return;
        }
        let mut keeper = null_mut();
        assert_ne!(
            unsafe {
                DuplicateHandle(
                    GetCurrentProcess(),
                    pi.hProcess,
                    GetCurrentProcess(),
                    &mut keeper,
                    0,
                    0,
                    DUPLICATE_SAME_ACCESS,
                )
            },
            0
        );
        FIXTURE_KEEPER.with(|v| *v.borrow_mut() = Some(Handle::new(keeper, ()).unwrap()));
        FIXTURE_RAW_HANDLES.with(|v| v.set((pi.hProcess as usize, pi.hThread as usize)));
    }
    #[cfg(test)]
    pub struct FixtureUnknown {
        pub outcome: Outcome,
        pub keeper: Handle,
        pub original_process: usize,
        pub original_thread: usize,
    }
    #[cfg(test)]
    impl Drop for FixtureUnknown {
        fn drop(&mut self) {
            // Only a test-owned duplicated handle to the exact benign child.
            // Also contain it if a lock assertion panics before reconciliation.
            if unsafe { WaitForSingleObject(self.keeper.raw(), 0) } != WAIT_OBJECT_0 {
                let stopped = unsafe { TerminateProcess(self.keeper.raw(), 0xE003_21F1) } != 0
                    && unsafe { WaitForSingleObject(self.keeper.raw(), 5000) } == WAIT_OBJECT_0;
                if !stopped {
                    // Prevent the field's subsequent Drop from closing the
                    // keeper whose retention this diagnostic promises.
                    self.keeper.raw = null_mut();
                    eprintln!(
                        "fixture child containment UNKNOWN; exact keeper retained until test-process exit"
                    );
                }
            }
        }
    }
    #[cfg(test)]
    pub fn launch_fixture_fault(
        prepared: Prepared,
        fault: FixtureFault,
    ) -> Result<FixtureUnknown, &'static str> {
        if !prepared.binding_path.starts_with(
            r"C:\Neurobro\scratch\phase3-prestart-p-g2-native-fixtures-20260905\",
        ) {
            return Err("fixture fault outside task-private root");
        }
        assert!(FIXTURE_FAULT.with(|v| v.replace(Some(fault))).is_none());
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                FIXTURE_FAULT.with(|v| v.set(None));
            }
        }
        let _reset = Reset;
        let outcome = launch_observed(prepared, |stage, _| {
            if stage == Stage::BeforeResume && fault == FixtureFault::TerminateFailed {
                Err("fixture requests suspended stop")
            } else {
                Ok(())
            }
        })?;
        let keeper = FIXTURE_KEEPER
            .with(|v| v.borrow_mut().take())
            .ok_or("fixture did not create actual child")?;
        let (original_process, original_thread) = FIXTURE_RAW_HANDLES.with(|v| v.get());
        Ok(FixtureUnknown {
            outcome,
            keeper,
            original_process,
            original_thread,
        })
    }
    struct Child {
        process: Handle,
        thread: Handle,
        pid: u32,
    }
    fn image_path(process: HANDLE) -> Result<String, &'static str> {
        let mut b = vec![0u16; 32768];
        let mut len = b.len() as u32;
        if unsafe { QueryFullProcessImageNameW(process, 0, b.as_mut_ptr(), &mut len) } == 0
            || len == 0
        {
            return Err("startup child image query failed");
        }
        let path = String::from_utf16(&b[..len as usize])
            .map_err(|_| "startup child image UTF-16 refused")?;
        Ok(path.strip_prefix(r"\\?\").unwrap_or(&path).into())
    }
    fn verify_child(child: &Child, prepared: &Prepared) -> Result<(), &'static str> {
        let path = image_path(child.process.raw())?;
        if path != prepared.binding.node.path {
            return Err("startup suspended Node image mismatch");
        }
        let actual = Pin::open(&path, false, AclPolicy::Startup, &prepared.owner)?;
        // files: external binding, self, Node, entry, carrier, launcher, observer.
        if actual.snapshot != prepared.files[2].snapshot {
            return Err("startup suspended Node identity mismatch");
        }
        prepared.verify()
    }
    fn unknown(prepared: Prepared, attempt: Attempt, child: Option<Child>) -> Outcome {
        // Keep process-local ownership until the executable's explicit parked
        // UNKNOWN state is reconciled externally. Crash continuity is not claimed.
        std::mem::forget((prepared, attempt, child));
        Outcome::UnknownRetained
    }
    #[allow(unused_mut)]
    fn stop(prepared: Prepared, attempt: Attempt, mut child: Child) -> Outcome {
        #[cfg(test)]
        if fault_is(FixtureFault::TerminateFailed) {
            // Close this test-owned process handle only; the independent keeper
            // remains available to reconcile the benign suspended process.
            assert_ne!(unsafe { CloseHandle(child.process.raw()) }, 0);
            child.process.raw = null_mut();
        }
        if unsafe { TerminateProcess(child.process.raw(), 0xE003_2101) } == 0
            || unsafe { WaitForSingleObject(child.process.raw(), 5000) } != WAIT_OBJECT_0
        {
            return unknown(prepared, attempt, Some(child));
        }
        if attempt.record("known-stopped", child.pid).is_err() {
            return unknown(prepared, attempt, Some(child));
        }
        Outcome::KnownStopped
    }
    pub fn launch(prepared: Prepared) -> Result<Outcome, &'static str> {
        launch_observed(prepared, |_, _| Ok(()))
    }
    pub fn launch_observed<F>(prepared: Prepared, mut observe: F) -> Result<Outcome, &'static str>
    where
        F: FnMut(Stage, &Prepared) -> Result<(), &'static str>,
    {
        observe(Stage::BeforeCreate, &prepared)?;
        prepared.verify()?;
        let attempt = Attempt::create(&prepared)?;
        // The attempt owns no authority; it only blocks replay after dispatch.
        prepared.verify()?;
        let binding = &prepared.binding;
        let mut command = wide(&command_line(binding));
        let env = environment();
        let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        let mut pi: PROCESS_INFORMATION = unsafe { zeroed() };
        let created = unsafe {
            CreateProcessW(
                wide(&binding.node.path).as_ptr(),
                command.as_mut_ptr(),
                null(),
                null(),
                0,
                CREATE_SUSPENDED
                    | CREATE_NO_WINDOW
                    | CREATE_UNICODE_ENVIRONMENT
                    | EXTENDED_STARTUPINFO_PRESENT,
                env.as_ptr().cast(),
                wide(&binding.cwd).as_ptr(),
                &startup.StartupInfo,
                &mut pi,
            )
        };
        if created == 0 {
            if attempt.record("never-started", 0).is_err() {
                return Ok(unknown(prepared, attempt, None));
            }
            return Ok(Outcome::NeverStarted);
        }
        #[cfg(test)]
        {
            capture_fixture_child(&pi);
            if fault_is(FixtureFault::MalformedCreate) {
                pi.dwThreadId = 0;
            }
        }
        if pi.hProcess.is_null()
            || pi.hProcess == INVALID_HANDLE_VALUE
            || pi.hThread.is_null()
            || pi.hThread == INVALID_HANDLE_VALUE
            || pi.hThread == pi.hProcess
            || pi.dwProcessId == 0
            || pi.dwThreadId == 0
        {
            // Returned partial handles are retained, not misreported as no-start.
            let _retained_raw_handles = (pi.hProcess, pi.hThread);
            return Ok(unknown(prepared, attempt, None));
        }
        #[allow(unused_mut)]
        let mut child = Child {
            process: Handle::new(pi.hProcess, ()).expect("checked handle"),
            thread: Handle::new(pi.hThread, ()).expect("checked handle"),
            pid: pi.dwProcessId,
        };
        if attempt.record("created-suspended", child.pid).is_err() {
            return Ok(stop(prepared, attempt, child));
        }
        if observe(Stage::Suspended, &prepared).is_err()
            || verify_child(&child, &prepared).is_err()
            || observe(Stage::BeforeResume, &prepared).is_err()
            || verify_child(&child, &prepared).is_err()
        {
            return Ok(stop(prepared, attempt, child));
        }
        if unsafe { ResumeThread(child.thread.raw()) } != 1 {
            return Ok(stop(prepared, attempt, child));
        }
        if attempt.record("resumed", child.pid).is_err()
            || observe(Stage::Resumed, &prepared).is_err()
        {
            return Ok(stop(prepared, attempt, child));
        }
        // No deadline/retry wrapper around the phase. Pins stay held until the
        // returned process handle proves exit. No worker or observer is launched here.
        #[cfg(test)]
        if fault_is(FixtureFault::WaitFailed) {
            assert_ne!(unsafe { CloseHandle(child.process.raw()) }, 0);
            child.process.raw = null_mut();
        }
        if unsafe { WaitForSingleObject(child.process.raw(), INFINITE) } != WAIT_OBJECT_0 {
            return Ok(unknown(prepared, attempt, Some(child)));
        }
        let mut exit = 0;
        if unsafe { GetExitCodeProcess(child.process.raw(), &mut exit) } == 0 {
            return Ok(unknown(prepared, attempt, Some(child)));
        }
        if observe(Stage::KnownExit, &prepared).is_err() || prepared.verify().is_err() {
            if attempt
                .record("known-exit-integrity-refused", child.pid)
                .is_err()
            {
                return Ok(unknown(prepared, attempt, Some(child)));
            }
            return Ok(Outcome::KnownStopped);
        }
        if attempt
            .record(&format!("known-exit-{exit}"), child.pid)
            .is_err()
        {
            return Ok(unknown(prepared, attempt, Some(child)));
        }
        Ok(Outcome::KnownExit(exit))
    }
}

fn main() {
    #[cfg(windows)]
    {
        let outcome = native::prepare_production().and_then(native::launch);
        match outcome {
            Ok(native::Outcome::KnownExit(0)) => {}
            Ok(native::Outcome::UnknownRetained) => {
                eprintln!(
                    "phase3-prestart-v1: UNKNOWN; retained in this process; no retry; external reconciliation required"
                );
                loop {
                    std::thread::park();
                }
            }
            _ => {
                eprintln!("phase3-prestart-v1: refused or known unsuccessful; no retry");
                std::process::exit(1);
            }
        }
    }
    #[cfg(not(windows))]
    {
        eprintln!("phase3-prestart-v1: Windows-only refusal");
        std::process::exit(1);
    }
}
