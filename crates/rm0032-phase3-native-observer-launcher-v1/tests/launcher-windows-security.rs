//! Connected Windows helpers only; never production launcher/observer execution.
#![cfg(windows)]
#![allow(dead_code)]
// Include the real launcher to exercise acquisition outcome propagation as well
// as its helper modules. Fixtures fail before any product-path capability.
#[path = "../src/main.rs"]
mod launcher;

use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use std::process::Command;

#[test]
fn native_observer_normalized_nt_binding() {
    use launcher::*;
    use sha2::{Digest, Sha256};
    const REQUEST_ID: &str = "8A1E79BC-3324-4B63-8A71-0AFA9D730C42";
    // Synthetic request only: the production helper opens the drive root for
    // metadata, never these fixture paths or any installed product resource.
    let payload = serde_json::to_vec(&serde_json::json!({
        "consumer": OBSERVER_REQUEST_CONSUMER, "operation": "read-bound-file",
        "requestId": REQUEST_ID, "rootPath": r"C:\DriveBindingFixture",
        "schema": OBSERVER_REQUEST_SCHEMA, "targetPath": r"C:\DriveBindingFixture\leaf",
        "version": "v1"
    })).unwrap();
    let hash = format!("{:x}", Sha256::digest(&payload));
    let envelope = WireEnvelope {
        schema: REQUEST_SCHEMA.into(), version: "v1".into(), request_id: REQUEST_ID.into(),
        correlation_id: "drive-binding-correlation".into(), carrier_sha256: "a".repeat(64),
        launcher_image_path: LAUNCHER_IMAGE_DOS.into(), launcher_image_sha256: "b".repeat(64),
        observer_image_path: OBSERVER_IMAGE_DOS.into(), observer_image_sha256: "c".repeat(64),
        evidence_root_absolute_path: ACCEPTED_EVIDENCE_ROOT_DOS.into(),
        stdin_sha256: hash.clone(), stdin_byte_count: payload.len() as u64, deadline_ms: 10_000,
    };
    let header = serde_json::to_vec(&envelope).unwrap();
    let supervisor = ProductionInvocationContext::new_supervisor(envelope,header,payload).unwrap();
    let worker = parse_production_input(Mode::Worker,&supervisor.supervisor_handoff_bytes().unwrap()).unwrap();
    let record = launcher::fixture_native_drive_anchor(&worker);
    let value: serde_json::Value = serde_json::from_str(&record).unwrap();
    assert_eq!(value["requestSha256"],hash);
    assert_eq!(value["drive"],"C:");
    assert_eq!(value["schema"],OBSERVER_DRIVE_BINDING_SCHEMA);
    assert_eq!(value.as_object().unwrap().len(),5);
    assert!(record.is_ascii() && record.len() <=1024);
    println!("NATIVE_OBSERVER_NORMALIZED_NT_BINDING metadata-only checked-close=true");
}

#[test]
fn native_observer_startup_compatibility() {
    launcher::native_observer_startup_fixture::copied_token_and_descriptor_readbacks();
}

#[test]
fn native_appcontainer_access_baseline_ordinary_token_refuses() {
    launcher::native_appcontainer_access_fixture::ordinary_token_and_invalid_acquisition_refuse();
}

#[test]
fn native_stdin_terminal_write_delivers_physical_eof() {
    run_bounded_pipe_child("native_stdin_eof_child", "NATIVE_STDIN_EOF_PASS");
}

#[test]
fn native_output_work_deadline_preserves_cleanup_reserve() {
    run_bounded_pipe_child(
        "native_output_deadline_child",
        "NATIVE_OUTPUT_DEADLINE_PASS",
    );
}

#[test]
fn native_cleanup_uses_one_absolute_budget_for_real_waits() {
    run_bounded_pipe_child("native_cleanup_budget_child", "NATIVE_CLEANUP_BUDGET_PASS");
}

#[test]
fn native_early_terminal_bounds_pending_stderr() {
    run_bounded_pipe_child("native_early_terminal_child", "NATIVE_EARLY_TERMINAL_PASS");
}

#[test]
fn native_expired_cleanup_does_not_retire_pending_io() {
    run_bounded_pipe_child(
        "native_expired_cleanup_child",
        "NATIVE_EXPIRED_CLEANUP_PASS",
    );
}

#[test]
fn native_stdin_incomplete_paths_preserve_owned_writer() {
    run_bounded_pipe_child(
        "native_stdin_hostile_child",
        "NATIVE_STDIN_HOSTILE_PASS case=broken-reader",
    );
}

#[test]
fn native_io_stop_retirement() {
    run_bounded_pipe_child("native_stdin_hostile_child", "NATIVE_IO_STOP_RETIREMENT");
}

#[test]
fn native_process_signal_wait_uses_partially_spent_work_budget() {
    launcher::native_process_signal_fixture::eof_before_process_signal_uses_partially_spent_work_budget(
        "native_process_raw_stdio_child",
    );
}

#[test]
fn native_process_signal_wait_excludes_cleanup_grace() {
    launcher::native_process_signal_fixture::process_wait_does_not_spend_cleanup_grace(
        "native_process_raw_stdio_child",
    );
}

#[test]
fn native_process_signal_expired_budget_does_not_wait() {
    launcher::native_process_signal_fixture::expired_process_budget_performs_no_wait(
        "native_process_raw_stdio_child",
    );
}

#[test]
fn native_process_signal_wait_error_fails_closed() {
    launcher::native_process_signal_fixture::invalid_process_handle_reports_wait_error(
        "native_process_raw_stdio_child",
    );
}

#[test]
fn native_process_signal_deadline_tie_survives_signaled_wait() {
    launcher::native_process_signal_fixture::signaled_wait_still_allows_deadline_tie(
        "native_process_raw_stdio_child",
    );
}

#[test]
fn native_process_signal_exit_259_remains_fail_closed() {
    launcher::native_process_signal_fixture::signaled_exit_code_259_remains_fail_closed(
        "native_process_exit_259_child",
    );
}

fn run_bounded_pipe_child(selector: &str, marker: &str) {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            selector,
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let started = std::time::Instant::now();
    loop {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        if started.elapsed() > std::time::Duration::from_secs(10) {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("native stdin fixture watchdog expired; no product process was executed");
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let output = child.wait_with_output().unwrap();
    println!("{}", String::from_utf8_lossy(&output.stdout));
    assert!(
        output.status.success(),
        "actual EOF fixture: {} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains(marker));
}

#[test]
#[ignore = "only the bounded owning test dispatches this real pipe fixture"]
fn native_stdin_eof_child() {
    launcher::native_stdin_fixture::physical_eof_after_actual_transfer();
}

#[test]
#[ignore = "only the bounded owning test dispatches this real pending-pipe fixture"]
fn native_output_deadline_child() {
    launcher::native_stdin_fixture::normal_output_does_not_spend_cleanup_grace();
}

#[test]
#[ignore = "owning bounded actual EOF and pending-stderr fixture only"]
fn native_early_terminal_child() {
    launcher::native_stdin_fixture::early_terminal_still_bounds_pending_stderr();
}

#[test]
#[ignore = "owning bounded actual pipe/process-wait fixture only"]
fn native_cleanup_budget_child() {
    launcher::native_stdin_fixture::cleanup_budget_is_shared_by_real_waits();
}

#[test]
#[ignore = "owning bounded actual pending-pipe fixture only"]
fn native_expired_cleanup_child() {
    launcher::native_stdin_fixture::expired_cleanup_retains_pending_operation();
}

#[test]
#[ignore = "owning bounded actual pending/broken/completed-count pipe fixtures only"]
fn native_stdin_hostile_child() {
    launcher::native_stdin_fixture::stdin_incomplete_paths_keep_the_writer_owned();
}

#[test]
#[ignore = "only the owning process-signal tests dispatch this inert raw-handle child"]
fn native_process_raw_stdio_child() {
    launcher::native_process_signal_fixture::raw_stdio_eof_child();
}

#[test]
#[ignore = "only the owning exit-code-259 test dispatches this inert child"]
fn native_process_exit_259_child() {
    launcher::native_process_signal_fixture::exit_259_child();
}

#[test]
fn native_snapshot_integrity_comparator_preserves_every_other_field() {
    launcher::native_snapshot_fixture::assert_integrity_contract();
}

#[test]
fn native_snapshot_actual_readonly_file_and_reopen() {
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "native_snapshot_actual_file_child",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .output()
        .unwrap();
    println!("{}", String::from_utf8_lossy(&output.stdout));
    assert!(
        output.status.success(),
        "native fixture child: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("NATIVE_SNAPSHOT_FIXTURE_PASS"));
}

#[test]
#[ignore = "exact disposable fixture child; no product executable or ledger"]
fn native_snapshot_actual_file_child() {
    launcher::native_snapshot_fixture::observe_actual_file();
}

fn production_environment() -> Vec<(String, String)> {
    let block = launcher::fixture_fixed_environment_block().unwrap();
    assert!(block.ends_with(&[0, 0]));
    assert!(!block.ends_with(&[0, 0, 0]));
    block[..block.len() - 2]
        .split(|unit| *unit == 0)
        .map(|entry| {
            let entry = String::from_utf16(entry).unwrap();
            let (key, value) = entry.split_once('=').unwrap();
            (key.to_owned(), value.to_owned())
        })
        .collect()
}

#[test]
fn native_environment_production_builder_reaches_known_folder() {
    // Seed only a disposable test driver; ambient spelling (e.g. C:\WINDOWS)
    // must not make the production-builder test depend on the Cargo parent.
    run_api_child(
        "native_environment_production_driver",
        vec![
            ("SystemDrive".into(), "C:".into()),
            ("SystemRoot".into(), r"C:\Windows".into()),
            ("WINDIR".into(), r"C:\Windows".into()),
        ],
        "NATIVE_ENVIRONMENT_DRIVER_PASS",
    );
}

fn run_api_child(selector: &str, environment: Vec<(OsString, OsString)>, marker: &str) -> Vec<u8> {
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            selector,
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env_clear()
        .envs(environment)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "API child: {} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains(marker));
    output.stdout
}

#[test]
#[ignore = "disposable production-builder driver; selected only by owning test"]
fn native_environment_production_driver() {
    // Do not hand-code the desired third key here: the child receives exactly
    // what the production builder emits, including in the pre-repair RED run.
    let environment: Vec<(OsString, OsString)> = production_environment()
        .into_iter()
        .map(|(key, value)| (key.into(), value.into()))
        .collect();
    run_api_child(
        "native_environment_known_folder_api_child",
        environment.clone(),
        "NATIVE_ENVIRONMENT_KNOWN_FOLDER_API_PASS",
    );
    // All hostile cases change actual child process input, not a mock table.
    for index in 0..3 {
        let mut missing = environment.clone();
        missing.remove(index);
        run_api_child(
            "native_environment_refusal_api_child",
            missing,
            "NATIVE_ENVIRONMENT_REFUSAL_API_PASS",
        );
        for wrong in [
            OsString::from("D:"),
            OsString::from("C:\\Windows\\"),
            OsString::from(""),
            OsString::from_wide(&[0xD800]),
        ] {
            let mut changed = environment.clone();
            changed[index].1 = wrong;
            run_api_child(
                "native_environment_refusal_api_child",
                changed,
                "NATIVE_ENVIRONMENT_REFUSAL_API_PASS",
            );
        }
        // Cross-key expected values are not interchangeable.
        let mut crossed = environment.clone();
        crossed[index].1 = if index == 0 {
            r"C:\Windows".into()
        } else {
            "C:".into()
        };
        run_api_child(
            "native_environment_refusal_api_child",
            crossed,
            "NATIVE_ENVIRONMENT_REFUSAL_API_PASS",
        );
    }
    let mut extras = environment;
    extras.extend([
        ("PATH".into(), r"D:\untrusted".into()),
        ("ProgramData".into(), r"D:\untrusted".into()),
        ("ALLUSERSPROFILE".into(), r"D:\untrusted".into()),
        ("RM0032_UNTRUSTED_EXTRA".into(), "must-not-propagate".into()),
    ]);
    run_api_child(
        "native_environment_extras_api_child",
        extras,
        "NATIVE_ENVIRONMENT_EXTRAS_API_PASS",
    );
    println!("NATIVE_ENVIRONMENT_DRIVER_PASS positive=1 negative=18 extras=1");
}

#[test]
#[ignore = "API-only child invoked with the actual production closed environment"]
fn native_environment_known_folder_api_child() {
    let block = launcher::fixture_fixed_environment_block().unwrap();
    // This is the real Windows Known Folder helper, before any product effects.
    launcher::fixture_verify_program_data_binding()
        .expect("actual production environment must resolve fixed ProgramData");
    assert_eq!(
        String::from_utf16(&block).unwrap(),
        "SystemDrive=C:\0SystemRoot=C:\\Windows\0WINDIR=C:\\Windows\0\0"
    );
    assert_eq!(
        std::env::vars_os().count(),
        3,
        "closed API child has no ambient extras"
    );
    assert!(
        launcher::fixture_validate_environment_binding()
            .into_iter()
            .all(|reply| matches!(reply, launcher::KernelReply::Ok))
    );
    println!("NATIVE_ENVIRONMENT_KNOWN_FOLDER_API_PASS");
}

#[test]
#[ignore = "hostile API-only child selected by owning test"]
fn native_environment_refusal_api_child() {
    assert!(launcher::fixture_fixed_environment_block().is_err());
    assert!(
        launcher::fixture_validate_environment_binding()
            .into_iter()
            .all(|reply| matches!(reply, launcher::KernelReply::Refused(_)))
    );
    for kind in [launcher::ChildKind::Worker, launcher::ChildKind::Observer] {
        let mut provider = EnvironmentProviderFixture {
            value: Err("base refusal precedes KnownFolder"),
            hostile_directory: None,
            queries: 0,
            directories: 0,
        };
        let mut creates = 0;
        let binding = launcher::fixture_generated_drive_binding();
        let result = launcher::with_child_environment(kind, &mut provider,
            (kind == launcher::ChildKind::Observer).then_some(&binding), |_| {
            creates += 1;
            Ok(())
        });
        assert!(matches!(
            result,
            Err(launcher::NativeCreateError::Precondition(_))
        ));
        assert_eq!((creates, provider.queries, provider.directories), (0, 0, 0));
    }
    println!("NATIVE_ENVIRONMENT_REFUSAL_API_PASS");
}

#[test]
#[ignore = "extra-environment API-only child selected by owning test"]
fn native_environment_extras_api_child() {
    assert_eq!(
        std::env::var("RM0032_UNTRUSTED_EXTRA").unwrap(),
        "must-not-propagate"
    );
    let environment = production_environment()
        .into_iter()
        .map(|(key, value)| (key.into(), value.into()))
        .collect();
    run_api_child(
        "native_environment_known_folder_api_child",
        environment,
        "NATIVE_ENVIRONMENT_KNOWN_FOLDER_API_PASS",
    );
    println!("NATIVE_ENVIRONMENT_EXTRAS_API_PASS");
}

#[test]
fn native_observer_environment_production_builder() {
    let base: Vec<(OsString, OsString)> = vec![
        ("SystemDrive".into(), "C:".into()),
        ("SystemRoot".into(), r"C:\Windows".into()),
        ("WINDIR".into(), r"C:\Windows".into()),
    ];
    let clean = run_api_child(
        "native_observer_environment_api_child",
        base.clone(),
        "NATIVE_OBSERVER_ENVIRONMENT_PASS",
    );
    let mut hostile = base.clone();
    hostile.extend([
        (launcher::OBSERVER_DRIVE_BINDING_KEY.into(), "ambient-forged-binding".into()),
        ("LOCALAPPDATA".into(), r"D:\untrusted-profile".into()),
        ("USERPROFILE".into(), r"D:\untrusted-profile".into()),
        ("PATH".into(), r"D:\untrusted-loader".into()),
    ]);
    let extra = run_api_child(
        "native_observer_environment_hostile_api_child",
        hostile,
        "NATIVE_OBSERVER_ENVIRONMENT_COMPLETE",
    );
    let clean = String::from_utf8(clean).expect("clean child output is UTF-8");
    let extra = String::from_utf8(extra).expect("hostile child output is UTF-8");
    let pass = "NATIVE_OBSERVER_ENVIRONMENT_PASS worker=3 observer=4 caller-unchanged=true";
    let refused =
        "NATIVE_OBSERVER_ENVIRONMENT_REFUSED known-folder-query-failed caller-unchanged=true";
    let complete = "NATIVE_OBSERVER_ENVIRONMENT_COMPLETE";
    let count = |output: &str, marker: &str| output.lines().filter(|line| *line == marker).count();
    let digest = |output: &str| {
        let lines: Vec<_> = output
            .lines()
            .filter_map(|line| line.strip_prefix("OBSERVER_ENV_SHA256="))
            .collect();
        assert_eq!(lines.len(), 1, "exactly one digest is required for success");
        assert!(
            lines[0].len() == 64
                && lines[0]
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        );
        lines[0].to_owned()
    };
    for output in [&clean, &extra] {
        assert_eq!(
            count(output, complete),
            1,
            "exactly one complete outcome is required"
        );
        assert_eq!(
            output
                .lines()
                .filter(|line| line.starts_with("NATIVE_OBSERVER_ENVIRONMENT_"))
                .count(),
            2,
            "only one typed outcome and its completion marker are allowed"
        );
    }
    assert_eq!(count(&clean, pass), 1, "clean three-key input must succeed");
    assert_eq!(count(&clean, refused), 0);
    let clean_digest = digest(&clean);
    match (count(&extra, pass), count(&extra, refused)) {
        (1, 0) => assert_eq!(
            clean_digest,
            digest(&extra),
            "hostile success must retain the clean environment"
        ),
        (0, 1) => assert!(
            !extra
                .lines()
                .any(|line| line.starts_with("OBSERVER_ENV_SHA256=")),
            "a refused builder must not return an environment digest"
        ),
        _ => panic!("hostile child must report exactly one permitted typed outcome"),
    }
    run_api_child(
        "native_observer_environment_hostile_child",
        base,
        "NATIVE_OBSERVER_ENVIRONMENT_HOSTILES_PASS",
    );
}

#[test]
#[ignore = "API-only self child, mandatory success under exact three-key input; no product process"]
fn native_observer_environment_api_child() {
    observe_observer_environment(false);
}

#[test]
#[ignore = "API-only self child with explicit hostile extras; exact KnownFolder refusal or unchanged success"]
fn native_observer_environment_hostile_api_child() {
    observe_observer_environment(true);
}

fn observe_observer_environment(allow_known_folder_refusal: bool) {
    use sha2::{Digest, Sha256};
    let mut before: Vec<_> = std::env::vars_os().collect();
    before.sort();
    let original = launcher::fixture_fixed_environment_block().unwrap();
    let worker = launcher::fixture_child_environment(launcher::ChildKind::Worker).unwrap();
    assert!(
        worker == original,
        "Worker must retain the fixed three-key block"
    );
    let observation = launcher::fixture_child_environment(launcher::ChildKind::Observer);
    let mut after: Vec<_> = std::env::vars_os().collect();
    after.sort();
    assert!(
        before == after,
        "builder must not mutate caller environment on either outcome"
    );
    let observer = match observation {
        Ok(block) => block,
        Err(launcher::NativeCreateError::Precondition("LocalAppData KnownFolder query failed"))
            if allow_known_folder_refusal =>
        {
            // No block was returned by the actual production builder. Its
            // shared pre-create continuation was therefore not reached.
            println!(
                "\nNATIVE_OBSERVER_ENVIRONMENT_REFUSED known-folder-query-failed caller-unchanged=true"
            );
            println!("NATIVE_OBSERVER_ENVIRONMENT_COMPLETE");
            return;
        }
        Err(reason) => panic!("unexpected observer environment refusal: {reason:?}"),
    };
    let binding_end = observer.iter().position(|unit| *unit == 0).unwrap();
    assert_eq!(String::from_utf16(&observer[..binding_end]).unwrap(),
        format!("{}={}", launcher::OBSERVER_DRIVE_BINDING_KEY,
            launcher::fixture_generated_drive_binding().canonical_record()));
    let observer_suffix = &observer[binding_end + 1..];
    let first_end = observer_suffix.iter().position(|unit| *unit == 0).unwrap();
    let prefix: Vec<_> = "LOCALAPPDATA=".encode_utf16().collect();
    assert!(observer_suffix.starts_with(&prefix));
    assert!(first_end > prefix.len());
    assert!(
        &observer_suffix[first_end + 1..] == original.as_slice(),
        "Observer must retain the exact fixed suffix"
    );
    assert_eq!(observer.iter().filter(|unit| **unit == 0).count(), 6);
    assert!(observer.ends_with(&[0, 0]));
    assert!(observer.len() <= 32_767);
    let bytes: Vec<_> = observer
        .iter()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    println!("\nOBSERVER_ENV_SHA256={:x}", Sha256::digest(bytes));
    println!("NATIVE_OBSERVER_ENVIRONMENT_PASS worker=3 observer=4 caller-unchanged=true");
    println!("NATIVE_OBSERVER_ENVIRONMENT_COMPLETE");
}

struct EnvironmentProviderFixture {
    value: Result<Option<Vec<u16>>, &'static str>,
    hostile_directory: Option<&'static str>,
    queries: usize,
    directories: usize,
}
impl launcher::ChildEnvironmentProvider for EnvironmentProviderFixture {
    fn local_app_data(&mut self) -> Result<Option<Vec<u16>>, &'static str> {
        self.queries += 1;
        self.value.clone()
    }
    fn directory(
        &mut self,
        path: &str,
    ) -> Result<launcher::LocalDirectoryObservation, &'static str> {
        self.directories += 1;
        if self.hostile_directory == Some("absent") {
            return Err("fixture directory is absent");
        }
        Ok(launcher::LocalDirectoryObservation {
            final_path: if self.hostile_directory == Some("redirected") {
                r"\\?\D:\elsewhere".into()
            } else {
                path.into()
            },
            directory: self.hostile_directory != Some("file"),
            delete_pending: self.hostile_directory == Some("delete-pending"),
            reparse: self.hostile_directory == Some("reparse"),
        })
    }
}

#[test]
#[ignore = "hostile provider observations through the production builder and pre-create gate only"]
fn native_observer_environment_hostile_child() {
    use launcher::{ChildKind, NativeCreateError};
    let valid = || Some(r"C:\Fixture\Local".encode_utf16().collect::<Vec<_>>());
    let binding = launcher::fixture_generated_drive_binding();
    let mut provider = EnvironmentProviderFixture {
        value: Err("must not query Worker KnownFolder"),
        hostile_directory: None,
        queries: 0,
        directories: 0,
    };
    let mut creates = 0;
    launcher::with_child_environment(ChildKind::Worker, &mut provider, None, |block| {
        creates += 1;
        assert_eq!(block, launcher::fixture_fixed_environment_block().unwrap());
        Ok(())
    })
    .unwrap();
    assert_eq!((creates, provider.queries, provider.directories), (1, 0, 0));
    assert!(launcher::with_child_environment::<_, ()>(ChildKind::Observer, &mut provider, None, |_| {
        panic!("missing binding reached creation")
    }).is_err());
    assert!(launcher::with_child_environment::<_, ()>(ChildKind::Worker, &mut provider, Some(&binding), |_| {
        panic!("Worker binding reached creation")
    }).is_err());
    assert_eq!((provider.queries, provider.directories), (0, 0));

    let mut paths = vec![
        Err("fixture KnownFolder API failure"),
        Ok(None),
        Ok(Some(vec![0xd800])),
        Ok(Some(vec![b'C' as u16; 32_767])),
    ];
    for path in [
        "",
        r"relative\Local",
        r"\\server\share",
        r"\\?\C:\Local",
        r"C:\..\Local",
        r"C:\.\Local",
        r"C:\Local\",
        r"C:\Local.",
        r"C:\Local ",
        r"C:\Local:stream",
        "C:\\Local\0hidden",
    ] {
        paths.push(Ok(Some(path.encode_utf16().collect())));
    }
    for value in paths {
        let mut provider = EnvironmentProviderFixture {
            value,
            hostile_directory: None,
            queries: 0,
            directories: 0,
        };
        let mut creates = 0;
        let result = launcher::with_child_environment(ChildKind::Observer, &mut provider, Some(&binding), |_| {
            creates += 1;
            Ok(())
        });
        assert!(matches!(result, Err(NativeCreateError::Precondition(_))));
        assert_eq!((creates, provider.queries, provider.directories), (0, 1, 0));
    }
    for hostile_directory in ["absent", "reparse", "file", "delete-pending", "redirected"] {
        let mut provider = EnvironmentProviderFixture {
            value: Ok(valid()),
            hostile_directory: Some(hostile_directory),
            queries: 0,
            directories: 0,
        };
        let mut creates = 0;
        let result = launcher::with_child_environment(ChildKind::Observer, &mut provider, Some(&binding), |_| {
            creates += 1;
            Ok(())
        });
        assert!(matches!(result, Err(NativeCreateError::Precondition(_))));
        assert_eq!((creates, provider.queries, provider.directories), (0, 1, 1));
    }
    let mut provider = EnvironmentProviderFixture {
        value: Ok(valid()),
        hostile_directory: None,
        queries: 0,
        directories: 0,
    };
    let mut creates = 0;
    launcher::with_child_environment(ChildKind::Observer, &mut provider, Some(&binding), |block| {
        creates += 1;
        assert_eq!(String::from_utf16(block).unwrap(),
            format!("{}={}\0LOCALAPPDATA=C:\\Fixture\\Local\0SystemDrive=C:\0SystemRoot=C:\\Windows\0WINDIR=C:\\Windows\0\0",
                launcher::OBSERVER_DRIVE_BINDING_KEY, binding.canonical_record()));
        Ok(())
    }).unwrap();
    assert_eq!((creates, provider.queries, provider.directories), (1, 1, 3));
    println!("NATIVE_OBSERVER_ENVIRONMENT_HOSTILES_PASS");
}

#[test]
fn native_create_error_capture_precedes_cleanup() {
    use launcher::{ChildKind, NativeCreateError};
    use windows_sys::Win32::Foundation::{GetLastError, SetLastError};
    struct CleanupClobber;
    impl Drop for CleanupClobber {
        fn drop(&mut self) {
            unsafe {
                SetLastError(1234);
            }
        }
    }
    for role in [ChildKind::Worker, ChildKind::Observer] {
        for code in [203, 5, 0, u32::MAX] {
            let mut calls = 0;
            let captured = {
                let _cleanup = CleanupClobber;
                unsafe {
                    SetLastError(999);
                }
                launcher::capture_native_create(role, || {
                    calls += 1;
                    assert_eq!(unsafe { GetLastError() }, 0, "wrapper reset is connected");
                    unsafe {
                        SetLastError(code);
                    }
                    0
                })
            };
            assert_eq!(unsafe { GetLastError() }, 1234);
            assert_eq!(
                captured,
                Err(NativeCreateError::False {
                    kind: role,
                    win32_error: code
                })
            );
            assert_eq!(
                launcher::native_create_reply(captured),
                launcher::KernelReply::CreateFalseTrustworthy {
                    kind: role,
                    win32_error: code
                }
            );
            assert_eq!(calls, 1);
        }
        let mut calls = 0;
        let captured = launcher::capture_native_create(role, || {
            calls += 1;
            unsafe {
                SetLastError(203);
            }
            1
        });
        assert_eq!(captured, Ok(()));
        assert_eq!(
            launcher::native_create_reply(captured),
            launcher::KernelReply::CreateTrue {
                process_info_valid: true
            }
        );
        assert_eq!(calls, 1);
    }
}
