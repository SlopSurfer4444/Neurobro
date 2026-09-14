#![cfg_attr(test, allow(dead_code))]

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::de::{DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fmt;
#[cfg(windows)]
use std::ptr::{null, null_mut};

#[cfg(windows)]
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_FILE_EXISTS, ERROR_NOT_A_REPARSE_POINT, GENERIC_READ, GENERIC_WRITE,
    GetLastError, HANDLE, INVALID_HANDLE_VALUE,
};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    CREATE_NEW, CreateFileW, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_BASIC_INFO,
    FILE_BEGIN, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_FLAG_WRITE_THROUGH,
    FILE_ID_INFO, FILE_NAME_NORMALIZED, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, FILE_STANDARD_INFO, FileBasicInfo, FileIdInfo, FileStandardInfo,
    FlushFileBuffers, GetFileInformationByHandleEx, GetFinalPathNameByHandleW, OPEN_EXISTING,
    ReadFile, SetFilePointerEx, VOLUME_NAME_NT, WriteFile,
};
#[cfg(windows)]
use windows_sys::Win32::System::IO::DeviceIoControl;
#[cfg(windows)]
use windows_sys::Win32::System::Ioctl::FSCTL_GET_REPARSE_POINT;

pub const REQUEST_SCHEMA: &str = "decadans.rm0032.native-observer-request.v1";
pub const OBSERVATION_SCHEMA: &str = "decadans.rm0032.native-observer-observation.v1";
pub const ACKNOWLEDGMENT_SCHEMA: &str = "decadans.rm0032.native-observer-ack.v1";
pub const PRE_OBSERVATION_REFUSAL_SCHEMA: &str =
    "decadans.rm0032.native-observer-pre-observation-refusal.v1";
pub const TERMINAL_SCHEMA: &str = "decadans.rm0032.native-observer-terminal-failure.v1";
pub const VERSION: &str = "v1";
pub const CONSUMER: &str = "rm-0032-phase3-hardening-coordinator";
pub const CLI_MODE: &str = "observe-v1";
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub const OPERATION_DEADLINE_MS: u64 = 10_000;
pub const AGGREGATE_DEADLINE_MS: u64 = 15_000;
pub const DRAIN_GRACE_MS: u64 = 5_000;
pub const DRIVE_BINDING_ENV: &str = "DECADANS_OBSERVER_DRIVE_BINDING_V1";
pub const DRIVE_BINDING_SCHEMA: &str = "decadans.rm0032.observer-drive-binding.v1";

// This is an immutable, request-specific record from the accepted launcher environment.
// It is not authentication of a standalone Observer or an atomic DOS namespace claim.
#[derive(Clone, Debug)]
pub struct DriveBinding {
    drive: String,
    nt_volume_root: String,
    volume_serial_number: u64,
}

pub fn parse_drive_binding(
    raw: &str,
    payload_sha256: &str,
    drive: &str,
) -> Result<DriveBinding, &'static str> {
    if raw.is_empty() || raw.len() > 1024 || !raw.is_ascii() {
        return Err("drive binding is not bounded ASCII");
    }
    let value = parse_canonical_json_value(raw.as_bytes())?;
    let record = value.as_object().ok_or("drive binding must be an object")?;
    if !has_exact_properties(record, &[
        "drive", "ntVolumeRoot", "requestSha256", "schema", "volumeSerialNumber",
    ]) {
        return Err("drive binding property set is not exact");
    }
    let bound_drive = string_field(record, "drive")?;
    let nt_volume_root = string_field(record, "ntVolumeRoot")?;
    let request_sha256 = string_field(record, "requestSha256")?;
    let volume = string_field(record, "volumeSerialNumber")?;
    if string_field(record, "schema")? != DRIVE_BINDING_SCHEMA
        || bound_drive.len() != 2
        || !bound_drive.as_bytes()[0].is_ascii_uppercase()
        || bound_drive.as_bytes()[1] != b':'
        || bound_drive != drive
        || !validate_sha256(payload_sha256)
        || request_sha256 != payload_sha256
        || !exact_lower_hex(volume, 16)
    {
        return Err("drive binding scalar or request correlation differs");
    }
    let digits = nt_volume_root
        .strip_prefix("\\Device\\HarddiskVolume")
        .and_then(|tail| tail.strip_suffix('\\'))
        .ok_or("drive binding NT root grammar differs")?;
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("drive binding NT root grammar differs");
    }
    Ok(DriveBinding {
        drive: bound_drive.to_owned(),
        nt_volume_root: nt_volume_root.to_owned(),
        volume_serial_number: u64::from_str_radix(volume, 16)
            .map_err(|_| "drive binding volume differs")?,
    })
}

pub fn normalized_nt_to_dos(
    binding: &DriveBinding,
    observed_nt: &str,
    observed_volume: u64,
) -> Result<String, ProofFailure> {
    if observed_volume != binding.volume_serial_number
        || observed_nt.encode_utf16().count() > 32_767
    {
        return Err(ProofFailure::DeterministicDrift);
    }
    // The trailing separator in the validated NT root is the exact device-component boundary.
    // Only the suffix actually returned for this same held handle supplies the DOS spelling.
    let suffix = observed_nt.strip_prefix(&binding.nt_volume_root)
        .ok_or(ProofFailure::DeterministicDrift)?;
    let final_path = format!("\\\\?\\{}\\{suffix}", binding.drive);
    parse_trusted_final_path(&final_path).map_err(|_| ProofFailure::DeterministicDrift)?;
    Ok(final_path)
}

fn environment_units(value: &std::ffi::OsStr) -> usize {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        value.encode_wide().count()
    }
    #[cfg(not(windows))]
    {
        // Production file operations are Windows-only; preserve a conservative fixture bound.
        value.to_str().map_or(value.len(), |text| text.encode_utf16().count())
    }
}

fn drive_binding_from_snapshot(
    snapshot: impl IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
    payload_sha256: &str,
    drive: &str,
) -> Result<DriveBinding, &'static str> {
    let mut units = 1usize; // final environment-block NUL, plus key=value\0 per entry
    let mut raw = None;
    for (key, value) in snapshot {
        units = units.checked_add(environment_units(&key))
            .and_then(|total| total.checked_add(environment_units(&value)))
            .and_then(|total| total.checked_add(2))
            .filter(|total| *total <= 32_767)
            .ok_or("environment snapshot exceeds bound")?;
        if key.to_str().is_some_and(|key| key.eq_ignore_ascii_case(DRIVE_BINDING_ENV)) {
            if key != std::ffi::OsStr::new(DRIVE_BINDING_ENV) || raw.is_some() {
                return Err("drive binding key is duplicated or has a case alias");
            }
            if environment_units(&value) > 1024 {
                return Err("drive binding exceeds UTF-16 bound");
            }
            raw = Some(value.into_string().map_err(|_| "drive binding is not Unicode")?);
        }
    }
    parse_drive_binding(&raw.ok_or("drive binding is missing")?, payload_sha256, drive)
}

#[cfg(test)]
pub fn parse_fixture_drive_binding_snapshot(
    snapshot: Vec<(std::ffi::OsString, std::ffi::OsString)>,
    payload_sha256: &str,
    drive: &str,
) -> Result<DriveBinding, &'static str> {
    drive_binding_from_snapshot(snapshot, payload_sha256, drive)
}

#[derive(Clone, Debug)]
pub struct CanonicalRequest {
    value: Value,
}

impl CanonicalRequest {
    fn field(&self, key: &str) -> &str {
        self.value[key]
            .as_str()
            .expect("canonical request fields were validated as strings")
    }

    pub fn operation(&self) -> &str {
        self.field("operation")
    }

    pub fn request_id(&self) -> &str {
        self.field("requestId")
    }

    pub fn root_path(&self) -> &str {
        self.field("rootPath")
    }

    pub fn target_path(&self) -> &str {
        self.field("targetPath")
    }

    pub fn content_base64(&self) -> Option<&str> {
        self.value.get("contentBase64").and_then(Value::as_str)
    }

    pub fn set_for_test(&mut self, key: &str, value: Value) {
        if let Some(record) = self.value.as_object_mut() {
            record.insert(key.to_owned(), value);
        }
    }
}

pub fn sha256_lower(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn sorted_value(value: &Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.iter().map(sorted_value).collect()),
        Value::Object(record) => {
            let mut keys: Vec<&String> = record.keys().collect();
            keys.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
            let mut sorted = Map::new();
            for key in keys {
                sorted.insert(key.clone(), sorted_value(&record[key]));
            }
            Value::Object(sorted)
        }
        other => other.clone(),
    }
}

struct StrictValueSeed;

impl<'de> DeserializeSeed<'de> for StrictValueSeed {
    type Value = Value;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_any(StrictValueVisitor)
    }
}

struct StrictValueVisitor;

impl<'de> Visitor<'de> for StrictValueVisitor {
    type Value = Value;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a strict JSON value")
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(Value::Bool(value))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
        Ok(Value::Number(value.into()))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        Ok(Value::Number(value.into()))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        serde_json::Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| E::custom("non-finite JSON number"))
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        Ok(Value::String(value.to_owned()))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(Value::String(value))
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(Value::Null)
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(Value::Null)
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element_seed(StrictValueSeed)? {
            values.push(value);
        }
        Ok(Value::Array(values))
    }

    fn visit_map<A>(self, mut entries: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut keys = HashSet::new();
        let mut record = Map::new();
        while let Some(key) = entries.next_key::<String>()? {
            if !keys.insert(key.clone()) {
                return Err(serde::de::Error::custom(format!(
                    "duplicate JSON property: {key}"
                )));
            }
            record.insert(key, entries.next_value_seed(StrictValueSeed)?);
        }
        Ok(Value::Object(record))
    }
}

fn validate_only_quote_and_backslash_escapes(bytes: &[u8]) -> Result<(), &'static str> {
    let mut in_string = false;
    let mut escaped = false;
    for byte in bytes {
        if !in_string {
            if *byte == b'"' {
                in_string = true;
            }
            continue;
        }
        if escaped {
            if !matches!(*byte, b'"' | b'\\') {
                return Err("JSON string uses a forbidden escape");
            }
            escaped = false;
        } else if *byte == b'\\' {
            escaped = true;
        } else if *byte == b'"' {
            in_string = false;
        }
    }
    if in_string || escaped {
        return Err("JSON string is unterminated");
    }
    Ok(())
}

fn validate_json_domain(value: &Value) -> Result<(), &'static str> {
    match value {
        Value::Null | Value::Bool(_) => Ok(()),
        Value::Number(number) => {
            if let Some(value) = number.as_i64() {
                if value.unsigned_abs() <= MAX_SAFE_INTEGER {
                    return Ok(());
                }
            } else if let Some(value) = number.as_u64()
                && value <= MAX_SAFE_INTEGER
            {
                return Ok(());
            }
            Err("JSON number is not a canonical safe integer")
        }
        Value::String(text) => validate_string_domain(text),
        Value::Array(values) => values.iter().try_for_each(validate_json_domain),
        Value::Object(record) => {
            for (key, entry) in record {
                validate_string_domain(key)?;
                validate_json_domain(entry)?;
            }
            Ok(())
        }
    }
}

fn validate_string_domain(text: &str) -> Result<(), &'static str> {
    if text
        .chars()
        .any(|character| matches!(character as u32, 0x00..=0x1f | 0x7f..=0x9f))
    {
        return Err("JSON string contains a forbidden control scalar");
    }
    Ok(())
}

pub fn parse_canonical_json_value(bytes: &[u8]) -> Result<Value, &'static str> {
    if bytes.is_empty()
        || bytes.starts_with(&[0xef, 0xbb, 0xbf])
        || bytes.last().is_some_and(u8::is_ascii_whitespace)
    {
        return Err("input is not bare canonical UTF-8 JSON");
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "input is not strict UTF-8")?;
    validate_only_quote_and_backslash_escapes(bytes)?;
    let mut deserializer = serde_json::Deserializer::from_str(text);
    let value = StrictValueSeed
        .deserialize(&mut deserializer)
        .map_err(|_| "input is not strict duplicate-free JSON")?;
    deserializer
        .end()
        .map_err(|_| "input contains trailing JSON data")?;
    validate_json_domain(&value)?;
    let canonical =
        serde_json::to_vec(&sorted_value(&value)).map_err(|_| "canonical JSON encoding failed")?;
    if canonical != bytes {
        return Err("input bytes differ from canonical encoding");
    }
    Ok(value)
}

fn string_field<'a>(record: &'a Map<String, Value>, key: &str) -> Result<&'a str, &'static str> {
    record
        .get(key)
        .and_then(Value::as_str)
        .ok_or("request field must be a string")
}

pub fn parse_canonical_request(bytes: &[u8]) -> Result<CanonicalRequest, &'static str> {
    let value = parse_canonical_json_value(bytes)?;
    let record = value.as_object().ok_or("request must be an object")?;
    let operation = string_field(record, "operation")?;
    let expected: &[&str] = match operation {
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
        _ => return Err("operation is not admitted"),
    };
    if record.len() != expected.len() || expected.iter().any(|key| !record.contains_key(*key)) {
        return Err("request property set is not exact");
    }
    if string_field(record, "schema")? != REQUEST_SCHEMA
        || string_field(record, "version")? != VERSION
        || string_field(record, "consumer")? != CONSUMER
    {
        return Err("request authority literals differ");
    }
    for key in expected {
        string_field(record, key)?;
    }
    Ok(CanonicalRequest { value })
}

fn canonical_correlation_seed(bytes: &[u8]) -> Option<(String, String, String)> {
    let value = parse_canonical_json_value(bytes).ok()?;
    let record = value.as_object()?;
    let operation = record.get("operation")?.as_str()?;
    let request_id = record.get("requestId")?.as_str()?;
    if !matches!(operation, "read-bound-file" | "create-new-durable-file")
        || !validate_request_id(request_id)
    {
        return None;
    }
    Some((
        operation.to_owned(),
        request_id.to_owned(),
        sha256_lower(bytes),
    ))
}

pub fn canonical_request_bytes(request: &CanonicalRequest) -> Vec<u8> {
    serde_json::to_vec(&sorted_value(&request.value)).expect("validated JSON is serializable")
}

pub fn validate_request_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36
        || bytes[8] != b'-'
        || bytes[13] != b'-'
        || bytes[18] != b'-'
        || bytes[23] != b'-'
        || bytes[14] != b'4'
        || !matches!(bytes[19], b'8' | b'9' | b'A' | b'B')
    {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| {
        matches!(index, 8 | 13 | 18 | 23) || byte.is_ascii_digit() || matches!(*byte, b'A'..=b'F')
    })
}

pub fn validate_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

pub fn decode_canonical_base64(value: &str, maximum_bytes: usize) -> Result<Vec<u8>, &'static str> {
    let maximum_encoded_bytes = maximum_bytes
        .checked_add(2)
        .and_then(|value| value.checked_div(3))
        .and_then(|value| value.checked_mul(4))
        .ok_or("contentBase64 cap arithmetic overflow")?;
    if value.len() > maximum_encoded_bytes
        || !value.len().is_multiple_of(4)
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
    {
        return Err("contentBase64 is not canonical Base64");
    }
    let decoded = STANDARD
        .decode(value)
        .map_err(|_| "contentBase64 is not strict Base64")?;
    if decoded.len() > maximum_bytes || STANDARD.encode(&decoded) != value {
        return Err("contentBase64 binding is noncanonical or oversized");
    }
    Ok(decoded)
}

fn validate_path_component(component: &str) -> Result<(), &'static str> {
    if component.is_empty()
        || component == "."
        || component == ".."
        || component.contains(':')
        || component.contains(['<', '>', '"', '|', '?', '*'])
        || component.ends_with(['.', ' '])
    {
        return Err("path component is not canonical");
    }
    validate_string_domain(component)?;
    let stem = component.split('.').next().unwrap_or(component);
    let reserved = stem.to_ascii_uppercase();
    let reserved_device_number = reserved
        .strip_prefix("COM")
        .or_else(|| reserved.strip_prefix("LPT"));
    if matches!(
        reserved.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$" | "CONIN$" | "CONOUT$"
    ) || reserved_device_number.is_some_and(|suffix| {
        let mut characters = suffix.chars();
        matches!(characters.next(), Some('1'..='9' | '¹' | '²' | '³'))
            && characters.next().is_none()
    }) {
        return Err("reserved DOS path component");
    }
    Ok(())
}

fn parse_input_path(path: &str) -> Result<(u8, Vec<&str>), &'static str> {
    if path.is_empty()
        || path.len() > 1024
        || path.contains('/')
        || path.len() < 3
        || !path.as_bytes()[0].is_ascii_uppercase()
        || path.as_bytes()[1] != b':'
        || path.as_bytes()[2] != b'\\'
    {
        return Err("path is not an uppercase-drive DOS absolute path");
    }
    validate_string_domain(path)?;
    let tail = &path[3..];
    let components = if tail.is_empty() {
        Vec::new()
    } else {
        tail.split('\\').collect::<Vec<_>>()
    };
    components
        .iter()
        .try_for_each(|component| validate_path_component(component))?;
    Ok((path.as_bytes()[0], components))
}

pub fn validate_input_path_pair(root: &str, target: &str) -> Result<(), &'static str> {
    let (root_drive, root_components) = parse_input_path(root)?;
    let (target_drive, target_components) = parse_input_path(target)?;
    if root_drive != target_drive || target_components.len() <= root_components.len() {
        return Err("target is not a strict descendant on the same drive");
    }
    if root_components.iter().zip(target_components.iter()).any(
        |(root_component, target_component)| {
            root_component.as_bytes() != target_component.as_bytes()
        },
    ) {
        return Err("target lexical components differ from root");
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FinalContainment {
    Contained,
    NonIdentical,
    Invalid,
}

fn parse_trusted_final_path(path: &str) -> Result<Vec<Vec<u16>>, &'static str> {
    let bytes = path.as_bytes();
    if bytes.len() < 7
        || bytes[0..4] != *b"\\\\?\\"
        || !bytes[4].is_ascii_uppercase()
        || bytes[5] != b':'
        || bytes[6] != b'\\'
        || path.contains('/')
    {
        return Err("final path lacks the exact extended DOS prefix");
    }
    validate_string_domain(path)?;
    let mut components = vec![path[4..6].encode_utf16().collect::<Vec<_>>()];
    let tail = &path[7..];
    if !tail.is_empty() {
        for component in tail.split('\\') {
            if component.is_empty() || component == "." || component == ".." {
                return Err("final path contains a noncanonical component");
            }
            components.push(component.encode_utf16().collect());
        }
    }
    Ok(components)
}

pub fn validate_final_containment(root: &str, target: &str) -> FinalContainment {
    let Ok(root_components) = parse_trusted_final_path(root) else {
        return FinalContainment::Invalid;
    };
    let Ok(target_components) = parse_trusted_final_path(target) else {
        return FinalContainment::Invalid;
    };
    if target_components.len() <= root_components.len() {
        return FinalContainment::Invalid;
    }
    for (root_component, target_component) in root_components.iter().zip(target_components.iter()) {
        if root_component.len() != target_component.len() || root_component != target_component {
            return FinalContainment::NonIdentical;
        }
    }
    FinalContainment::Contained
}

pub fn expected_target_final_path(
    input_root: &str,
    input_target: &str,
    held_root_final_path: &str,
) -> Result<String, ProofFailure> {
    validate_input_path_pair(input_root, input_target)
        .map_err(|_| ProofFailure::DeterministicDrift)?;
    if parse_trusted_final_path(held_root_final_path).is_err() {
        return Err(ProofFailure::DeterministicDrift);
    }
    let suffix = input_target
        .strip_prefix(input_root)
        .ok_or(ProofFailure::DeterministicDrift)?;
    let expected = format!("{held_root_final_path}{suffix}");
    parse_trusted_final_path(&expected).map_err(|_| ProofFailure::DeterministicDrift)?;
    Ok(expected)
}

pub fn validate_exact_target_final_path(
    input_root: &str,
    input_target: &str,
    held_root_final_path: &str,
    observed_target_final_path: &str,
) -> Result<(), ProofFailure> {
    let expected = expected_target_final_path(input_root, input_target, held_root_final_path)?;
    let expected_components =
        parse_trusted_final_path(&expected).map_err(|_| ProofFailure::DeterministicDrift)?;
    let observed_components = parse_trusted_final_path(observed_target_final_path)
        .map_err(|_| ProofFailure::DeterministicDrift)?;
    if expected_components == observed_components {
        Ok(())
    } else {
        Err(ProofFailure::NonIdenticalSpelling)
    }
}

pub fn validate_exact_opened_final_path(
    input_path: &str,
    observed_final_path: &str,
) -> Result<(), ProofFailure> {
    parse_input_path(input_path).map_err(|_| ProofFailure::DeterministicDrift)?;
    let expected = format!("\\\\?\\{input_path}");
    let expected_components =
        parse_trusted_final_path(&expected).map_err(|_| ProofFailure::DeterministicDrift)?;
    let observed_components = parse_trusted_final_path(observed_final_path)
        .map_err(|_| ProofFailure::DeterministicDrift)?;
    if expected_components == observed_components {
        Ok(())
    } else {
        Err(ProofFailure::NonIdenticalSpelling)
    }
}

fn legal_terminal_tuple(
    operation: &str,
    outcome: &str,
    failure_stage: &str,
    effect_state: &str,
) -> bool {
    matches!(
        (operation, outcome, failure_stage, effect_state),
        ("read-bound-file", "refused", "pre-effect", "none")
            | ("read-bound-file", "unknown", "pre-effect", "none")
            | ("read-bound-file", "refused", "read-observation", "none")
            | ("read-bound-file", "unknown", "read-observation", "none")
            | ("create-new-durable-file", "refused", "pre-effect", "none")
            | ("create-new-durable-file", "unknown", "pre-effect", "none")
            | (
                "create-new-durable-file",
                "refused",
                "create-collision",
                "not-created"
            )
            | (
                "create-new-durable-file",
                "unknown",
                "post-create",
                "possibly-created"
            )
    )
}

fn has_exact_properties(record: &Map<String, Value>, expected: &[&str]) -> bool {
    record.len() == expected.len() && expected.iter().all(|key| record.contains_key(*key))
}

pub fn pre_observation_refusal() -> Value {
    serde_json::json!({
        "schema": PRE_OBSERVATION_REFUSAL_SCHEMA,
        "version": VERSION,
        "consumer": CONSUMER,
        "outcome": "refused",
        "failureStage": "pre-observation"
    })
}

pub fn correlated_terminal(
    operation: &str,
    request_id: &str,
    request_sha256: &str,
    outcome: &str,
    failure_stage: &str,
    effect_state: &str,
) -> Result<Value, &'static str> {
    if !validate_request_id(request_id)
        || !validate_sha256(request_sha256)
        || !legal_terminal_tuple(operation, outcome, failure_stage, effect_state)
    {
        return Err("correlated terminal tuple or scalar is not legal");
    }
    Ok(serde_json::json!({
        "schema": TERMINAL_SCHEMA,
        "version": VERSION,
        "consumer": CONSUMER,
        "operation": operation,
        "requestId": request_id,
        "requestSha256": request_sha256,
        "outcome": outcome,
        "failureStage": failure_stage,
        "effectState": effect_state
    }))
}

pub fn validate_terminal(value: &Value) -> Result<(), &'static str> {
    let record = value.as_object().ok_or("terminal must be an object")?;
    let schema = string_field(record, "schema")?;
    if schema == PRE_OBSERVATION_REFUSAL_SCHEMA {
        if !has_exact_properties(
            record,
            &["schema", "version", "consumer", "outcome", "failureStage"],
        ) || string_field(record, "version")? != VERSION
            || string_field(record, "consumer")? != CONSUMER
            || string_field(record, "outcome")? != "refused"
            || string_field(record, "failureStage")? != "pre-observation"
        {
            return Err("pre-observation refusal is not exact");
        }
        return Ok(());
    }
    if schema != TERMINAL_SCHEMA
        || !has_exact_properties(
            record,
            &[
                "schema",
                "version",
                "consumer",
                "operation",
                "requestId",
                "requestSha256",
                "outcome",
                "failureStage",
                "effectState",
            ],
        )
        || string_field(record, "version")? != VERSION
        || string_field(record, "consumer")? != CONSUMER
        || !validate_request_id(string_field(record, "requestId")?)
        || !validate_sha256(string_field(record, "requestSha256")?)
        || !legal_terminal_tuple(
            string_field(record, "operation")?,
            string_field(record, "outcome")?,
            string_field(record, "failureStage")?,
            string_field(record, "effectState")?,
        )
    {
        return Err("correlated terminal is not exact or legal");
    }
    Ok(())
}

pub fn validate_cli_args(arguments: &[String]) -> bool {
    matches!(arguments, [mode] if mode == CLI_MODE)
}

pub fn canonical_json_bytes(value: &Value) -> Result<Vec<u8>, &'static str> {
    validate_json_domain(value)?;
    serde_json::to_vec(&sorted_value(value)).map_err(|_| "canonical JSON encoding failed")
}

pub fn success_frame(observation: &Value, acknowledgment: &Value) -> Result<Vec<u8>, &'static str> {
    let observation_bytes = canonical_json_bytes(observation)?;
    let acknowledgment_bytes = canonical_json_bytes(acknowledgment)?;
    if observation_bytes.len() > 1_048_576 || acknowledgment_bytes.len() > 65_536 {
        return Err("success frame member exceeds its cap");
    }
    let mut frame = Vec::with_capacity(observation_bytes.len() + 1 + acknowledgment_bytes.len());
    frame.extend_from_slice(&observation_bytes);
    frame.push(b'\n');
    frame.extend_from_slice(&acknowledgment_bytes);
    if frame.len() > 1_114_113 {
        return Err("success frame exceeds its exact cap");
    }
    Ok(frame)
}

pub fn finalize_success_frame(
    frame: Result<Vec<u8>, &'static str>,
    deadline_expired_after_construction: bool,
) -> Result<Vec<u8>, &'static str> {
    if deadline_expired_after_construction {
        Err("deadline expired after success frame construction")
    } else {
        frame
    }
}

pub fn terminal_frame(terminal: &Value) -> Result<Vec<u8>, &'static str> {
    validate_terminal(terminal)?;
    let frame = canonical_json_bytes(terminal)?;
    if frame.len() > 65_536 {
        return Err("terminal frame exceeds its exact cap");
    }
    Ok(frame)
}

fn canonical_decimal_u64(value: &str) -> bool {
    value
        .parse::<u64>()
        .is_ok_and(|parsed| parsed.to_string() == value)
}

fn exact_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileIdentity {
    pub volume_serial_number: String,
    pub file_id: String,
    pub size: String,
    pub last_write_time: String,
    pub file_attributes: String,
    pub final_path: String,
}

impl FileIdentity {
    pub fn from_value(value: &Value) -> Result<Self, &'static str> {
        let record = value.as_object().ok_or("identity must be an object")?;
        if !has_exact_properties(
            record,
            &[
                "volumeSerialNumber",
                "fileId",
                "size",
                "lastWriteTime",
                "fileAttributes",
                "finalPath",
            ],
        ) {
            return Err("identity property set is not exact");
        }
        let volume_serial_number = string_field(record, "volumeSerialNumber")?;
        let file_id = string_field(record, "fileId")?;
        let size = string_field(record, "size")?;
        let last_write_time = string_field(record, "lastWriteTime")?;
        let file_attributes = string_field(record, "fileAttributes")?;
        let final_path = string_field(record, "finalPath")?;
        if !exact_lower_hex(volume_serial_number, 16)
            || !exact_lower_hex(file_id, 32)
            || !canonical_decimal_u64(size)
            || !canonical_decimal_u64(last_write_time)
            || !exact_lower_hex(file_attributes, 8)
            || parse_trusted_final_path(final_path).is_err()
        {
            return Err("identity scalar grammar differs");
        }
        Ok(Self {
            volume_serial_number: volume_serial_number.to_owned(),
            file_id: file_id.to_owned(),
            size: size.to_owned(),
            last_write_time: last_write_time.to_owned(),
            file_attributes: file_attributes.to_owned(),
            final_path: final_path.to_owned(),
        })
    }

    pub fn to_value(&self) -> Value {
        serde_json::json!({
            "volumeSerialNumber": self.volume_serial_number,
            "fileId": self.file_id,
            "size": self.size,
            "lastWriteTime": self.last_write_time,
            "fileAttributes": self.file_attributes,
            "finalPath": self.final_path
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProofFailure {
    DeterministicDrift,
    Incomplete,
    NonIdenticalSpelling,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StableAncestorIdentity {
    pub volume_serial_number: String,
    pub file_id: String,
    pub final_path: String,
    pub directory: bool,
    pub reparse_free: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StableAncestorBinding {
    pub handle_id: u64,
    pub identity: StableAncestorIdentity,
}

pub fn validate_stable_ancestor_revalidation(
    initial: &[StableAncestorIdentity],
    current: &[StableAncestorIdentity],
) -> Result<(), ProofFailure> {
    if initial.is_empty() || initial.len() != current.len() {
        return Err(ProofFailure::Incomplete);
    }
    for (before, after) in initial.iter().zip(current) {
        if !before.directory
            || !after.directory
            || !before.reparse_free
            || !after.reparse_free
            || before != after
        {
            return Err(ProofFailure::Incomplete);
        }
    }
    Ok(())
}

pub fn validate_stable_ancestor_binding_revalidation(
    initial: &[StableAncestorBinding],
    current: &[StableAncestorBinding],
) -> Result<(), ProofFailure> {
    if initial.is_empty() || initial.len() != current.len() {
        return Err(ProofFailure::Incomplete);
    }
    let mut handles = HashSet::new();
    for (before, after) in initial.iter().zip(current) {
        if before.handle_id == 0
            || !handles.insert(before.handle_id)
            || before.handle_id != after.handle_id
            || before.identity != after.identity
        {
            return Err(ProofFailure::Incomplete);
        }
    }
    validate_stable_ancestor_revalidation(
        &initial
            .iter()
            .map(|binding| binding.identity.clone())
            .collect::<Vec<_>>(),
        &current
            .iter()
            .map(|binding| binding.identity.clone())
            .collect::<Vec<_>>(),
    )
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReadObservationFailureClassification {
    Refused,
    Unknown,
}

pub fn classify_read_observation_failure(
    failure: ProofFailure,
) -> ReadObservationFailureClassification {
    match failure {
        ProofFailure::DeterministicDrift => ReadObservationFailureClassification::Refused,
        ProofFailure::Incomplete | ProofFailure::NonIdenticalSpelling => {
            ReadObservationFailureClassification::Unknown
        }
    }
}

pub fn classify_read_observation_failure_after_deadline(
    failure: ProofFailure,
    deadline_expired: bool,
) -> ReadObservationFailureClassification {
    if deadline_expired {
        ReadObservationFailureClassification::Unknown
    } else {
        classify_read_observation_failure(failure)
    }
}

pub fn validate_no_reparse_tag(tag: Option<u32>) -> Result<(), ProofFailure> {
    if tag.is_some() {
        Err(ProofFailure::DeterministicDrift)
    } else {
        Ok(())
    }
}

pub fn validate_read_progress(expected: usize, chunks: &[usize]) -> Result<(), ProofFailure> {
    let mut total = 0usize;
    for chunk in chunks {
        if *chunk == 0 && total < expected {
            return Err(ProofFailure::Incomplete);
        }
        if *chunk > 65_536 {
            return Err(ProofFailure::DeterministicDrift);
        }
        total = total.checked_add(*chunk).ok_or(ProofFailure::Incomplete)?;
        if total > expected {
            return Err(ProofFailure::DeterministicDrift);
        }
    }
    if total == expected {
        Ok(())
    } else {
        Err(ProofFailure::Incomplete)
    }
}

pub fn complete_read_proof(
    root_final_path: &str,
    identity_before: &FileIdentity,
    identity_after: &FileIdentity,
    content: &[u8],
) -> Result<(String, String), ProofFailure> {
    match validate_final_containment(root_final_path, &identity_before.final_path) {
        FinalContainment::Contained => {}
        FinalContainment::NonIdentical => return Err(ProofFailure::NonIdenticalSpelling),
        FinalContainment::Invalid => return Err(ProofFailure::DeterministicDrift),
    }
    if u32::from_str_radix(&identity_before.file_attributes, 16)
        .ok()
        .filter(|attributes| attributes & 0x10 == 0)
        .is_none()
        || u32::from_str_radix(&identity_after.file_attributes, 16)
            .ok()
            .filter(|attributes| attributes & 0x10 == 0)
            .is_none()
    {
        return Err(ProofFailure::DeterministicDrift);
    }
    if identity_before != identity_after
        || identity_before
            .size
            .parse::<usize>()
            .ok()
            .filter(|size| *size == content.len() && *size <= 262_144)
            .is_none()
    {
        return Err(ProofFailure::DeterministicDrift);
    }
    Ok((STANDARD.encode(content), sha256_lower(content)))
}

#[cfg(windows)]
#[derive(Debug)]
struct OwnedHandle {
    raw: HANDLE,
}

#[cfg(windows)]
impl OwnedHandle {
    fn new(raw: HANDLE) -> Result<Self, ProofFailure> {
        if raw.is_null() || raw == INVALID_HANDLE_VALUE {
            Err(ProofFailure::Incomplete)
        } else {
            Ok(Self { raw })
        }
    }

    fn close(&mut self) -> Result<(), ProofFailure> {
        if self.raw.is_null() || self.raw == INVALID_HANDLE_VALUE {
            return Ok(());
        }
        let raw = self.raw;
        self.raw = INVALID_HANDLE_VALUE;
        // SAFETY: `raw` is a valid uniquely owned handle and is consumed exactly once here.
        if unsafe { CloseHandle(raw) } == 0 {
            Err(ProofFailure::Incomplete)
        } else {
            Ok(())
        }
    }

    fn handle_id(&self) -> u64 {
        self.raw as usize as u64
    }
}

#[cfg(windows)]
#[derive(Debug)]
struct HeldAncestor {
    handle: OwnedHandle,
    initial: StableAncestorBinding,
}

#[cfg(windows)]
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.raw.is_null() && self.raw != INVALID_HANDLE_VALUE {
            let raw = self.raw;
            self.raw = INVALID_HANDLE_VALUE;
            // SAFETY: this is the sole fallback release for a still-owned valid handle.
            unsafe {
                CloseHandle(raw);
            }
        }
    }
}

#[cfg(windows)]
#[derive(Clone, Debug)]
struct NativeIdentity {
    contract: FileIdentity,
    directory: bool,
    reparse_free: bool,
}

#[cfg(windows)]
impl NativeIdentity {
    fn stable_ancestor(&self) -> StableAncestorIdentity {
        StableAncestorIdentity {
            volume_serial_number: self.contract.volume_serial_number.clone(),
            file_id: self.contract.file_id.clone(),
            final_path: self.contract.final_path.clone(),
            directory: self.directory,
            reparse_free: self.reparse_free,
        }
    }
}

#[cfg(windows)]
fn wide_native_dos_path(value: &str) -> Vec<u16> {
    format!("\\\\?\\{value}")
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(windows)]
fn open_directory(path: &str) -> Result<OwnedHandle, ProofFailure> {
    let path = wide_native_dos_path(path);
    // SAFETY: the path is NUL-terminated, all pointer arguments are valid for the call, and ownership
    // of a successful handle is immediately transferred to `OwnedHandle`.
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    OwnedHandle::new(handle)
}

#[cfg(windows)]
fn open_read_target(path: &str) -> Result<OwnedHandle, ProofFailure> {
    let path = wide_native_dos_path(path);
    // SAFETY: arguments follow the same ownership contract as `open_directory`.
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            GENERIC_READ | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    OwnedHandle::new(handle)
}

#[cfg(windows)]
fn query_normalized_nt_path(handle: HANDLE) -> Result<String, ProofFailure> {
    // SAFETY: the first call requests the required UTF-16 capacity and writes no buffer.
    let required = unsafe {
        GetFinalPathNameByHandleW(
            handle,
            null_mut(),
            0,
            FILE_NAME_NORMALIZED | VOLUME_NAME_NT,
        )
    };
    if required == 0 || required > 32_767 {
        return Err(ProofFailure::Incomplete);
    }
    let mut buffer = vec![0u16; required as usize + 1];
    // SAFETY: `buffer` is writable for the announced capacity and `handle` remains owned.
    let written = unsafe {
        GetFinalPathNameByHandleW(
            handle,
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            FILE_NAME_NORMALIZED | VOLUME_NAME_NT,
        )
    };
    if written == 0 || written as usize >= buffer.len() {
        return Err(ProofFailure::Incomplete);
    }
    String::from_utf16(&buffer[..written as usize]).map_err(|_| ProofFailure::Incomplete)
}

// Native temp-tree fixtures alone derive an environment record from a real drive handle.
// Production has no child drive-root open or mapping fallback; the launcher owns that anchor.
#[cfg(all(test, windows))]
pub fn fixture_drive_binding_record(input: &[u8]) -> Result<String, ProofFailure> {
    let request = parse_canonical_request(input).map_err(|_| ProofFailure::DeterministicDrift)?;
    validate_request_semantics(&request, input.len()).map_err(|_| ProofFailure::DeterministicDrift)?;
    let drive = &request.root_path()[..2];
    let root = format!("{drive}\\");
    let mut handle = open_directory(&root)?;
    let result = (|| {
        let mut id = FILE_ID_INFO::default();
        // SAFETY: the owned drive handle and correctly sized output structure remain valid.
        if unsafe { GetFileInformationByHandleEx(
            handle.raw, FileIdInfo, (&mut id as *mut FILE_ID_INFO).cast(),
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        ) } == 0 {
            return Err(ProofFailure::Incomplete);
        }
        let nt_root = query_normalized_nt_path(handle.raw)?;
        let raw = String::from_utf8(canonical_json_bytes(&serde_json::json!({
            "drive": drive,
            "ntVolumeRoot": nt_root,
            "requestSha256": sha256_lower(input),
            "schema": DRIVE_BINDING_SCHEMA,
            "volumeSerialNumber": format!("{:016x}", id.VolumeSerialNumber),
        })).map_err(|_| ProofFailure::Incomplete)?).map_err(|_| ProofFailure::Incomplete)?;
        let binding = parse_drive_binding(&raw, &sha256_lower(input), drive)
            .map_err(|_| ProofFailure::DeterministicDrift)?;
        let observed = query_identity(handle.raw, &binding)?;
        if !observed.directory {
            return Err(ProofFailure::DeterministicDrift);
        }
        validate_exact_opened_final_path(&root, &observed.contract.final_path)?;
        // Fixture parent-equivalent DOS equality checks the actual drive alias as well.
        let mut dos = [0u16; 16];
        // SAFETY: this fixture-only normalized DOS query has a valid owned handle and buffer.
        let written = unsafe { GetFinalPathNameByHandleW(
            handle.raw, dos.as_mut_ptr(), dos.len() as u32,
            FILE_NAME_NORMALIZED | windows_sys::Win32::Storage::FileSystem::VOLUME_NAME_DOS,
        ) };
        if written == 0 || written as usize >= dos.len() {
            return Err(ProofFailure::Incomplete);
        }
        let observed_dos = String::from_utf16(&dos[..written as usize])
            .map_err(|_| ProofFailure::Incomplete)?;
        validate_exact_opened_final_path(&root, &observed_dos)?;
        if query_identity(handle.raw, &binding)?.contract != observed.contract {
            return Err(ProofFailure::DeterministicDrift);
        }
        Ok(raw)
    })();
    handle.close()?;
    result
}

#[cfg(windows)]
fn query_reparse_tag(handle: HANDLE) -> Result<Option<u32>, ProofFailure> {
    let mut buffer = [0u8; 16 * 1024];
    let mut returned = 0u32;
    // SAFETY: the output buffer is valid and no overlapped operation is requested.
    let result = unsafe {
        DeviceIoControl(
            handle,
            FSCTL_GET_REPARSE_POINT,
            null(),
            0,
            buffer.as_mut_ptr().cast(),
            buffer.len() as u32,
            &mut returned,
            null_mut(),
        )
    };
    if result != 0 {
        if returned < 4 {
            return Err(ProofFailure::Incomplete);
        }
        return Ok(Some(u32::from_le_bytes(
            buffer[0..4].try_into().expect("four bytes"),
        )));
    }
    // SAFETY: this immediately captures the failure from `DeviceIoControl`.
    let error = unsafe { GetLastError() };
    if error == ERROR_NOT_A_REPARSE_POINT {
        Ok(None)
    } else {
        Err(ProofFailure::Incomplete)
    }
}

#[cfg(windows)]
fn query_identity(handle: HANDLE, binding: &DriveBinding) -> Result<NativeIdentity, ProofFailure> {
    let mut id = FILE_ID_INFO::default();
    let mut standard = FILE_STANDARD_INFO::default();
    let mut basic = FILE_BASIC_INFO::default();
    // SAFETY: each output pointer references a correctly sized writable structure for the selected class.
    if unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileIdInfo,
            (&mut id as *mut FILE_ID_INFO).cast(),
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    } == 0
        || unsafe {
            GetFileInformationByHandleEx(
                handle,
                FileStandardInfo,
                (&mut standard as *mut FILE_STANDARD_INFO).cast(),
                std::mem::size_of::<FILE_STANDARD_INFO>() as u32,
            )
        } == 0
        || unsafe {
            GetFileInformationByHandleEx(
                handle,
                FileBasicInfo,
                (&mut basic as *mut FILE_BASIC_INFO).cast(),
                std::mem::size_of::<FILE_BASIC_INFO>() as u32,
            )
        } == 0
        || standard.EndOfFile < 0
    {
        return Err(ProofFailure::Incomplete);
    }
    validate_no_reparse_tag(query_reparse_tag(handle)?)?;
    let final_path = normalized_nt_to_dos(binding, &query_normalized_nt_path(handle)?, id.VolumeSerialNumber)?;
    if parse_trusted_final_path(&final_path).is_err() {
        return Err(ProofFailure::DeterministicDrift);
    }
    let file_id = id
        .FileId
        .Identifier
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(NativeIdentity {
        contract: FileIdentity {
            volume_serial_number: format!("{:016x}", id.VolumeSerialNumber),
            file_id,
            size: (standard.EndOfFile as u64).to_string(),
            last_write_time: (basic.LastWriteTime as u64).to_string(),
            file_attributes: format!("{:08x}", basic.FileAttributes),
            final_path,
        },
        directory: standard.Directory || basic.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0,
        reparse_free: true,
    })
}

#[cfg(windows)]
fn read_exact_handle(
    handle: HANDLE,
    expected: usize,
    deadline: std::time::Instant,
) -> Result<Vec<u8>, ProofFailure> {
    if expected > 262_144 {
        return Err(ProofFailure::DeterministicDrift);
    }
    let mut content = Vec::with_capacity(expected);
    while content.len() < expected {
        if std::time::Instant::now() >= deadline {
            return Err(ProofFailure::Incomplete);
        }
        let remaining = expected - content.len();
        let mut chunk = vec![0u8; remaining.min(65_536)];
        let mut read = 0u32;
        // SAFETY: `chunk` is writable for its full length and the synchronous byte-count pointer is valid.
        if unsafe {
            ReadFile(
                handle,
                chunk.as_mut_ptr(),
                chunk.len() as u32,
                &mut read,
                null_mut(),
            )
        } == 0
        {
            return Err(ProofFailure::Incomplete);
        }
        if read == 0 || read as usize > chunk.len() {
            return Err(ProofFailure::Incomplete);
        }
        content.extend_from_slice(&chunk[..read as usize]);
    }
    Ok(content)
}

#[cfg(windows)]
fn root_and_ancestor_paths(root: &str, target: &str) -> Result<Vec<String>, ProofFailure> {
    validate_input_path_pair(root, target).map_err(|_| ProofFailure::DeterministicDrift)?;
    let (_, root_components) =
        parse_input_path(root).map_err(|_| ProofFailure::DeterministicDrift)?;
    let (_, target_components) =
        parse_input_path(target).map_err(|_| ProofFailure::DeterministicDrift)?;
    let mut paths = vec![root.to_owned()];
    let mut current = root.to_owned();
    for component in &target_components[root_components.len()..target_components.len() - 1] {
        if !current.ends_with('\\') {
            current.push('\\');
        }
        current.push_str(component);
        paths.push(current.clone());
    }
    Ok(paths)
}

#[cfg(windows)]
fn release_all(handles: &mut [HeldAncestor]) -> Result<(), ProofFailure> {
    let mut failed = false;
    for ancestor in handles.iter_mut().rev() {
        failed |= ancestor.handle.close().is_err();
    }
    if failed {
        Err(ProofFailure::Incomplete)
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn finalize_failed_prepare(
    current: &mut OwnedHandle,
    held: &mut [HeldAncestor],
    _intended: ProofFailure,
) -> ProofFailure {
    let _current_failed = current.close().is_err();
    let _held_failed = release_all(held).is_err();
    // Once any native ancestor handle has been opened, failure to complete and
    // revalidate the whole stable chain is conservative rather than a trusted refusal.
    ProofFailure::Incomplete
}

#[cfg(windows)]
#[derive(Clone, Debug, Eq, PartialEq)]
enum NativeReadResult {
    Known {
        held_root_final_path: String,
        before: FileIdentity,
        after: Box<FileIdentity>,
        content: Vec<u8>,
    },
    RefusedPreEffect,
    UnknownPreEffect,
    RefusedReadObservation,
    UnknownReadObservation,
}

pub fn deadline_reached<T: Ord>(now: T, deadline: T) -> bool {
    now >= deadline
}

#[cfg(windows)]
fn execute_native_read(root: &str, target: &str, deadline: std::time::Instant, binding: &DriveBinding) -> NativeReadResult {
    let mut held = match prepare_held_ancestors(root, target, binding) {
        Ok(value) => value,
        Err(ProofFailure::DeterministicDrift) => return NativeReadResult::RefusedPreEffect,
        Err(ProofFailure::NonIdenticalSpelling | ProofFailure::Incomplete) => {
            return NativeReadResult::UnknownPreEffect;
        }
    };
    if deadline_reached(std::time::Instant::now(), deadline) {
        let _held_close_failed = release_all(&mut held).is_err();
        return NativeReadResult::UnknownPreEffect;
    }
    let mut target_handle = match open_read_target(target) {
        Ok(handle) => handle,
        Err(_) => {
            let _held_close_failed = release_all(&mut held).is_err();
            return NativeReadResult::UnknownPreEffect;
        }
    };
    let outcome = (|| -> NativeReadResult {
        if deadline_reached(std::time::Instant::now(), deadline) {
            return NativeReadResult::UnknownReadObservation;
        }
        let before = match query_identity(target_handle.raw, binding) {
            Ok(identity) if !identity.directory => identity,
            Ok(_) => return NativeReadResult::RefusedReadObservation,
            Err(error) => match classify_read_observation_failure_after_deadline(
                error,
                deadline_reached(std::time::Instant::now(), deadline),
            ) {
                ReadObservationFailureClassification::Refused => {
                    return NativeReadResult::RefusedReadObservation;
                }
                ReadObservationFailureClassification::Unknown => {
                    return NativeReadResult::UnknownReadObservation;
                }
            },
        };
        let root_final = &held[0].initial.identity.final_path;
        match validate_exact_target_final_path(
            root,
            target,
            root_final,
            &before.contract.final_path,
        ) {
            Ok(()) => {}
            Err(ProofFailure::NonIdenticalSpelling | ProofFailure::Incomplete) => {
                return NativeReadResult::UnknownReadObservation;
            }
            Err(ProofFailure::DeterministicDrift) => {
                return NativeReadResult::RefusedReadObservation;
            }
        }
        if before.contract.volume_serial_number != held[0].initial.identity.volume_serial_number {
            return NativeReadResult::RefusedReadObservation;
        }
        let expected = match before.contract.size.parse::<usize>() {
            Ok(size) if size <= 262_144 => size,
            Ok(_) => return NativeReadResult::RefusedReadObservation,
            Err(_) => return NativeReadResult::UnknownReadObservation,
        };
        let content = match read_exact_handle(target_handle.raw, expected, deadline) {
            Ok(bytes) => bytes,
            Err(_) => return NativeReadResult::UnknownReadObservation,
        };
        let after = match query_identity(target_handle.raw, binding) {
            Ok(identity) => identity,
            Err(error) => match classify_read_observation_failure_after_deadline(
                error,
                deadline_reached(std::time::Instant::now(), deadline),
            ) {
                ReadObservationFailureClassification::Refused => {
                    return NativeReadResult::RefusedReadObservation;
                }
                ReadObservationFailureClassification::Unknown => {
                    return NativeReadResult::UnknownReadObservation;
                }
            },
        };
        match validate_exact_target_final_path(root, target, root_final, &after.contract.final_path)
        {
            Ok(()) => {}
            Err(ProofFailure::DeterministicDrift) => {
                return NativeReadResult::RefusedReadObservation;
            }
            Err(ProofFailure::NonIdenticalSpelling | ProofFailure::Incomplete) => {
                return NativeReadResult::UnknownReadObservation;
            }
        }
        match complete_read_proof(root_final, &before.contract, &after.contract, &content) {
            Ok(_) => {}
            Err(ProofFailure::NonIdenticalSpelling | ProofFailure::Incomplete) => {
                return NativeReadResult::UnknownReadObservation;
            }
            Err(ProofFailure::DeterministicDrift) => {
                return NativeReadResult::RefusedReadObservation;
            }
        }
        match ancestors_unchanged(&held, binding) {
            Ok(()) => {}
            Err(ProofFailure::DeterministicDrift) => {
                return NativeReadResult::RefusedReadObservation;
            }
            Err(_) => return NativeReadResult::UnknownReadObservation,
        }
        NativeReadResult::Known {
            held_root_final_path: root_final.clone(),
            before: before.contract,
            after: Box::new(after.contract),
            content,
        }
    })();
    let ancestor_revalidation = ancestors_unchanged(&held, binding);
    let target_close = target_handle.close();
    let held_close = release_all(&mut held);
    if ancestor_revalidation.is_err()
        || target_close.is_err()
        || held_close.is_err()
        || deadline_reached(std::time::Instant::now(), deadline)
    {
        return NativeReadResult::UnknownReadObservation;
    }
    outcome
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CreateDispatch {
    Collision,
    InvalidNonCollision,
    AmbiguousNoHandle,
    ValidHandle,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreateTrace {
    pub dispatch: CreateDispatch,
    pub write_requests: Vec<usize>,
    pub write_returned: Option<usize>,
    pub flush: bool,
    pub size_proof: bool,
    pub rewind: bool,
    pub same_handle_readback: bool,
    pub release_original: bool,
    pub reopen: bool,
    pub reopened_identity: bool,
    pub reopened_readback: bool,
    pub release_reopened: bool,
    pub acknowledgment: bool,
    pub release_root_ancestors: bool,
}

impl CreateTrace {
    pub fn nonempty_success(content_length: usize) -> Self {
        Self {
            dispatch: CreateDispatch::ValidHandle,
            write_requests: vec![content_length],
            write_returned: Some(content_length),
            flush: true,
            size_proof: true,
            rewind: true,
            same_handle_readback: true,
            release_original: true,
            reopen: true,
            reopened_identity: true,
            reopened_readback: true,
            release_reopened: true,
            acknowledgment: true,
            release_root_ancestors: true,
        }
    }

    pub fn zero_valid_handle() -> Self {
        Self {
            dispatch: CreateDispatch::ValidHandle,
            write_requests: vec![0],
            write_returned: Some(0),
            flush: false,
            size_proof: false,
            rewind: false,
            same_handle_readback: false,
            release_original: true,
            reopen: false,
            reopened_identity: false,
            reopened_readback: false,
            release_reopened: false,
            acknowledgment: false,
            release_root_ancestors: true,
        }
    }

    pub fn zero_ambiguity_no_handle() -> Self {
        Self {
            dispatch: CreateDispatch::AmbiguousNoHandle,
            write_requests: Vec::new(),
            write_returned: None,
            flush: false,
            size_proof: false,
            rewind: false,
            same_handle_readback: false,
            release_original: false,
            reopen: false,
            reopened_identity: false,
            reopened_readback: false,
            release_reopened: false,
            acknowledgment: false,
            release_root_ancestors: true,
        }
    }

    pub fn collision() -> Self {
        Self {
            dispatch: CreateDispatch::Collision,
            write_requests: Vec::new(),
            write_returned: None,
            flush: false,
            size_proof: false,
            rewind: false,
            same_handle_readback: false,
            release_original: false,
            reopen: false,
            reopened_identity: false,
            reopened_readback: false,
            release_reopened: false,
            acknowledgment: false,
            release_root_ancestors: true,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CreateClassification {
    Known,
    RefusedCollision,
    RefusedPreEffect,
    UnknownPreEffect,
    UnknownPostCreate,
    InvalidTrace,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeTraceEvent {
    Acquire {
        binding: StableAncestorBinding,
    },
    CreateValid {
        handle: u64,
    },
    CreateInvalid,
    ReparseQueryInvalid,
    CaptureLastError {
        code: u32,
    },
    Clock {
        now: u64,
        deadline: u64,
    },
    Write {
        handle: u64,
        requested: usize,
        returned: Option<usize>,
    },
    Flush {
        handle: u64,
    },
    Identity {
        handle: u64,
        directory: bool,
        reparse_free: bool,
    },
    Rewind {
        handle: u64,
    },
    Readback {
        handle: u64,
    },
    Reopen {
        handle: u64,
    },
    RevalidateAncestors {
        current: Vec<StableAncestorBinding>,
    },
    Acknowledge,
    Failure,
    Close {
        handle: u64,
    },
}

pub fn classify_ordered_create_trace(
    events: &[NativeTraceEvent],
) -> Result<CreateClassification, &'static str> {
    let mut owned = Vec::<u64>::new();
    let mut ever_owned = HashSet::<u64>::new();
    let mut initial_ancestors = Vec::<StableAncestorBinding>::new();
    let mut acquisition_open = true;
    let mut create_valid_seen = false;
    let mut ambiguity: Option<(usize, CreateClassification)> = None;
    let mut pending_zero_write: Option<usize> = None;
    let mut revalidation_validity = Vec::<bool>::new();
    for (index, event) in events.iter().enumerate() {
        if let Some((barrier, _)) = ambiguity
            && index > barrier
            && !matches!(event, NativeTraceEvent::Close { .. })
        {
            return Err("native trace performed work after terminal ambiguity");
        }
        match event {
            NativeTraceEvent::Acquire { binding } => {
                if !acquisition_open
                    || !binding.identity.directory
                    || !binding.identity.reparse_free
                    || binding.handle_id == 0
                    || !ever_owned.insert(binding.handle_id)
                {
                    return Err("native trace ancestor acquisition is invalid or out of order");
                }
                owned.push(binding.handle_id);
                initial_ancestors.push(binding.clone());
            }
            NativeTraceEvent::CreateValid { handle } | NativeTraceEvent::Reopen { handle } => {
                acquisition_open = false;
                if *handle == 0 || !ever_owned.insert(*handle) {
                    return Err("native trace handle identity is zero or reused");
                }
                owned.push(*handle);
                create_valid_seen |= matches!(event, NativeTraceEvent::CreateValid { .. });
            }
            NativeTraceEvent::Close { handle } => {
                acquisition_open = false;
                if owned.pop() != Some(*handle) {
                    return Err("native trace release is not reverse-order exact-once");
                }
            }
            NativeTraceEvent::CreateInvalid | NativeTraceEvent::ReparseQueryInvalid
                if !matches!(
                    events.get(index + 1),
                    Some(NativeTraceEvent::CaptureLastError { .. })
                ) =>
            {
                return Err("GetLastError capture is not immediate");
            }
            NativeTraceEvent::CaptureLastError { .. }
                if !matches!(
                    index
                        .checked_sub(1)
                        .and_then(|previous| events.get(previous)),
                    Some(NativeTraceEvent::CreateInvalid | NativeTraceEvent::ReparseQueryInvalid)
                ) =>
            {
                return Err("GetLastError capture lacks an adjacent failed Win32 call");
            }
            NativeTraceEvent::Write { handle, .. }
            | NativeTraceEvent::Flush { handle }
            | NativeTraceEvent::Identity { handle, .. }
            | NativeTraceEvent::Rewind { handle }
            | NativeTraceEvent::Readback { handle }
                if owned.last() != Some(handle) =>
            {
                return Err(
                    "native trace operation does not use the uniquely active target handle",
                );
            }
            NativeTraceEvent::Write {
                requested,
                returned,
                ..
            } => {
                acquisition_open = false;
                if *requested == 0 {
                    pending_zero_write = Some(index);
                } else if *returned != Some(*requested) && ambiguity.is_none() {
                    ambiguity = Some((index, CreateClassification::UnknownPostCreate));
                }
            }
            NativeTraceEvent::RevalidateAncestors { current } => {
                acquisition_open = false;
                let all_still_owned = initial_ancestors
                    .iter()
                    .all(|binding| owned.contains(&binding.handle_id));
                revalidation_validity.push(
                    all_still_owned
                        && validate_stable_ancestor_binding_revalidation(
                            &initial_ancestors,
                            current,
                        )
                        .is_ok(),
                );
            }
            NativeTraceEvent::Acknowledge if !owned.is_empty() => {
                return Err("native trace acknowledged before releasing all owned handles");
            }
            NativeTraceEvent::Clock { now, deadline } => {
                acquisition_open = false;
                if pending_zero_write.is_some() && pending_zero_write == index.checked_sub(1) {
                    ambiguity = Some((index, CreateClassification::UnknownPostCreate));
                } else if now >= deadline && ambiguity.is_none() {
                    ambiguity = Some((
                        index,
                        if create_valid_seen {
                            CreateClassification::UnknownPostCreate
                        } else {
                            CreateClassification::UnknownPreEffect
                        },
                    ));
                }
            }
            NativeTraceEvent::CaptureLastError { code: 0 }
                if matches!(
                    index
                        .checked_sub(1)
                        .and_then(|previous| events.get(previous)),
                    Some(NativeTraceEvent::CreateInvalid)
                ) =>
            {
                acquisition_open = false;
                ambiguity = Some((index, CreateClassification::UnknownPostCreate));
            }
            NativeTraceEvent::Failure => {
                acquisition_open = false;
                if ambiguity.is_none() {
                    ambiguity = Some((
                        index,
                        if create_valid_seen {
                            CreateClassification::UnknownPostCreate
                        } else {
                            CreateClassification::UnknownPreEffect
                        },
                    ));
                }
            }
            _ => acquisition_open = false,
        }
    }
    if !owned.is_empty() {
        return Err("native trace retained an owned handle");
    }
    let clock_deadlines = events
        .iter()
        .filter_map(|event| match event {
            NativeTraceEvent::Clock { deadline, .. } => Some(*deadline),
            _ => None,
        })
        .collect::<HashSet<_>>();
    if clock_deadlines.len() != 1 {
        return Err("native trace clocks do not use one earliest active deadline");
    }
    if let Some(write_index) = pending_zero_write {
        let create_index = write_index
            .checked_sub(1)
            .ok_or("zero create chronology lacks its valid create")?;
        if create_index == 0
            || !matches!(events[create_index], NativeTraceEvent::CreateValid { .. })
            || !matches!(events[create_index - 1], NativeTraceEvent::Clock { .. })
            || !matches!(
                events.get(write_index + 1),
                Some(NativeTraceEvent::Clock { .. })
            )
            || events[write_index + 2..]
                .iter()
                .any(|event| !matches!(event, NativeTraceEvent::Close { .. }))
        {
            return Err(
                "zero create chronology performed proof work or skipped a required clock sample",
            );
        }
    }
    if let Some((_, classification)) = ambiguity {
        return Ok(classification);
    }

    if let Some(index) = events
        .iter()
        .position(|event| matches!(event, NativeTraceEvent::CreateInvalid))
    {
        if events.iter().any(|event| {
            matches!(
                event,
                NativeTraceEvent::CreateValid { .. }
                    | NativeTraceEvent::Write { .. }
                    | NativeTraceEvent::Flush { .. }
                    | NativeTraceEvent::Reopen { .. }
                    | NativeTraceEvent::Acknowledge
            )
        }) {
            return Err("invalid create dispatch performed post-create actions");
        }
        let code = match events.get(index + 1) {
            Some(NativeTraceEvent::CaptureLastError { code }) => *code,
            _ => return Err("invalid create dispatch lacks immediate error capture"),
        };
        let pre_create_clock =
            index > 0 && matches!(events[index - 1], NativeTraceEvent::Clock { .. });
        let post_error_clock = events[index + 2..]
            .iter()
            .position(|event| matches!(event, NativeTraceEvent::Clock { .. }))
            .map(|offset| index + 2 + offset);
        let revalidation_index = events
            .iter()
            .position(|event| matches!(event, NativeTraceEvent::RevalidateAncestors { .. }));
        return Ok(if code == 0 {
            CreateClassification::UnknownPostCreate
        } else if !pre_create_clock
            || post_error_clock.is_none()
            || revalidation_index.is_none()
            || post_error_clock >= revalidation_index
            || initial_ancestors.is_empty()
            || revalidation_validity.as_slice() != [true]
        {
            CreateClassification::UnknownPreEffect
        } else if code == 80 {
            CreateClassification::RefusedCollision
        } else {
            CreateClassification::RefusedPreEffect
        });
    }

    let create_valids = events
        .iter()
        .enumerate()
        .filter_map(|(index, event)| match event {
            NativeTraceEvent::CreateValid { handle } => Some((index, *handle)),
            _ => None,
        })
        .collect::<Vec<_>>();
    if create_valids.len() != 1 {
        return Err("native trace lacks exactly one valid create dispatch");
    }
    let (create_index, create_handle) = create_valids[0];

    let Some((write_index, write_handle, requested, returned)) =
        events.iter().enumerate().find_map(|(index, event)| {
            if let NativeTraceEvent::Write {
                handle,
                requested,
                returned,
            } = event
            {
                Some((index, *handle, *requested, *returned))
            } else {
                None
            }
        })
    else {
        return Err("valid create dispatch lacks its single write");
    };
    if events
        .iter()
        .filter(|event| matches!(event, NativeTraceEvent::Write { .. }))
        .count()
        != 1
    {
        return Err("valid create dispatch did not issue exactly one write");
    }
    if create_index >= write_index || write_handle != create_handle {
        return Err("native trace write is not bound to the created handle in order");
    }
    if create_index == 0
        || !matches!(events[create_index - 1], NativeTraceEvent::Clock { .. })
        || write_index != create_index + 1
    {
        return Err("native trace lacks the pre-create sample or froze the write chronology");
    }
    if requested == 0 {
        if !matches!(
            events.get(write_index + 1),
            Some(NativeTraceEvent::Clock { .. })
        ) || events[write_index + 2..]
            .iter()
            .any(|event| !matches!(event, NativeTraceEvent::Close { .. }))
        {
            return Err(
                "zero create chronology performed proof work or skipped its deadline sample",
            );
        }
        return Ok(CreateClassification::UnknownPostCreate);
    }

    if returned != Some(requested) {
        return Err("native trace short-write ambiguity escaped its cleanup barrier");
    }
    let flushes = events
        .iter()
        .enumerate()
        .filter_map(|(index, event)| match event {
            NativeTraceEvent::Flush { handle } => Some((index, *handle)),
            _ => None,
        })
        .collect::<Vec<_>>();
    let identities = events
        .iter()
        .enumerate()
        .filter_map(|(index, event)| match event {
            NativeTraceEvent::Identity {
                handle,
                directory,
                reparse_free,
            } => Some((index, *handle, *directory, *reparse_free)),
            _ => None,
        })
        .collect::<Vec<_>>();
    let rewinds = events
        .iter()
        .enumerate()
        .filter_map(|(index, event)| match event {
            NativeTraceEvent::Rewind { handle } => Some((index, *handle)),
            _ => None,
        })
        .collect::<Vec<_>>();
    let readbacks = events
        .iter()
        .enumerate()
        .filter_map(|(index, event)| match event {
            NativeTraceEvent::Readback { handle } => Some((index, *handle)),
            _ => None,
        })
        .collect::<Vec<_>>();
    let reopens = events
        .iter()
        .enumerate()
        .filter_map(|(index, event)| match event {
            NativeTraceEvent::Reopen { handle } => Some((index, *handle)),
            _ => None,
        })
        .collect::<Vec<_>>();
    let revalidations = events
        .iter()
        .enumerate()
        .filter_map(|(index, event)| {
            matches!(event, NativeTraceEvent::RevalidateAncestors { .. }).then_some(index)
        })
        .collect::<Vec<_>>();
    let acknowledgments = events
        .iter()
        .enumerate()
        .filter_map(|(index, event)| {
            matches!(event, NativeTraceEvent::Acknowledge).then_some(index)
        })
        .collect::<Vec<_>>();
    if flushes.len() != 1
        || identities.len() != 3
        || identities
            .iter()
            .any(|(_, _, directory, reparse_free)| *directory || !*reparse_free)
        || rewinds.len() != 1
        || readbacks.len() != 2
        || reopens.len() != 1
        || revalidations.len() != 1
        || initial_ancestors.is_empty()
        || revalidation_validity.as_slice() != [true]
        || acknowledgments.len() != 1
    {
        return Ok(CreateClassification::UnknownPostCreate);
    }
    let (reopen_index, reopen_handle) = reopens[0];
    let created_identity_indices = identities
        .iter()
        .filter_map(|(index, handle, _, _)| (*handle == create_handle).then_some(*index))
        .collect::<Vec<_>>();
    let reopened_identity_indices = identities
        .iter()
        .filter_map(|(index, handle, _, _)| (*handle == reopen_handle).then_some(*index))
        .collect::<Vec<_>>();
    let original_close = events
        .iter()
        .enumerate()
        .find_map(|(index, event)| match event {
            NativeTraceEvent::Close { handle } if *handle == create_handle => Some(index),
            _ => None,
        });
    let reopened_close = events
        .iter()
        .enumerate()
        .find_map(|(index, event)| match event {
            NativeTraceEvent::Close { handle } if *handle == reopen_handle => Some(index),
            _ => None,
        });
    if created_identity_indices.len() != 2
        || reopened_identity_indices.len() != 1
        || flushes[0].1 != create_handle
        || rewinds[0].1 != create_handle
        || readbacks[0].1 != create_handle
        || readbacks[1].1 != reopen_handle
        || original_close.is_none()
        || reopened_close.is_none()
    {
        return Ok(CreateClassification::UnknownPostCreate);
    }
    let original_close = original_close.expect("checked original close");
    let reopened_close = reopened_close.expect("checked reopened close");
    let ordered = create_index < write_index
        && write_index < flushes[0].0
        && flushes[0].0 < created_identity_indices[0]
        && created_identity_indices[0] < rewinds[0].0
        && rewinds[0].0 < readbacks[0].0
        && readbacks[0].0 < created_identity_indices[1]
        && created_identity_indices[1] < original_close
        && original_close < reopen_index
        && reopen_index < reopened_identity_indices[0]
        && reopened_identity_indices[0] < readbacks[1].0
        && readbacks[1].0 < revalidations[0]
        && revalidations[0] < reopened_close
        && reopened_close < acknowledgments[0]
        && events[readbacks[1].0 + 1..revalidations[0]]
            .iter()
            .any(|event| matches!(event, NativeTraceEvent::Clock { .. }));
    Ok(if ordered {
        CreateClassification::Known
    } else {
        CreateClassification::UnknownPostCreate
    })
}

#[cfg(windows)]
pub fn classify_create_open_error(error: u32) -> CreateClassification {
    if error == ERROR_FILE_EXISTS {
        CreateClassification::RefusedCollision
    } else if error == 0 {
        CreateClassification::UnknownPostCreate
    } else {
        CreateClassification::RefusedPreEffect
    }
}

#[cfg(windows)]
pub fn classify_create_open_error_after_deadline(
    error: u32,
    deadline_expired: bool,
) -> CreateClassification {
    classify_create_open_error_after_release(error, false, deadline_expired)
}

#[cfg(windows)]
pub fn classify_create_open_error_after_release(
    error: u32,
    release_failed: bool,
    deadline_expired: bool,
) -> CreateClassification {
    let classification = classify_create_open_error(error);
    if classification == CreateClassification::UnknownPostCreate {
        classification
    } else if release_failed || deadline_expired {
        CreateClassification::UnknownPreEffect
    } else {
        classification
    }
}

fn no_post_create_proof_actions(trace: &CreateTrace) -> bool {
    !trace.flush
        && !trace.size_proof
        && !trace.rewind
        && !trace.same_handle_readback
        && !trace.reopen
        && !trace.reopened_identity
        && !trace.reopened_readback
        && !trace.release_reopened
        && !trace.acknowledgment
}

pub fn classify_create_trace(content: &[u8], trace: &CreateTrace) -> CreateClassification {
    match trace.dispatch {
        CreateDispatch::Collision => {
            if trace.write_requests.is_empty()
                && !trace.release_original
                && trace.release_root_ancestors
                && no_post_create_proof_actions(trace)
            {
                CreateClassification::RefusedCollision
            } else {
                CreateClassification::InvalidTrace
            }
        }
        CreateDispatch::InvalidNonCollision => {
            if trace.write_requests.is_empty()
                && !trace.release_original
                && trace.release_root_ancestors
                && no_post_create_proof_actions(trace)
            {
                CreateClassification::RefusedPreEffect
            } else {
                CreateClassification::InvalidTrace
            }
        }
        CreateDispatch::AmbiguousNoHandle => {
            if trace.write_requests.is_empty()
                && !trace.release_original
                && trace.release_root_ancestors
                && no_post_create_proof_actions(trace)
            {
                CreateClassification::UnknownPostCreate
            } else {
                CreateClassification::InvalidTrace
            }
        }
        CreateDispatch::ValidHandle if content.is_empty() => {
            if trace.write_requests == [0]
                && trace.release_original
                && trace.release_root_ancestors
                && no_post_create_proof_actions(trace)
            {
                CreateClassification::UnknownPostCreate
            } else {
                CreateClassification::InvalidTrace
            }
        }
        CreateDispatch::ValidHandle => {
            if trace.write_requests == [content.len()]
                && trace.write_returned == Some(content.len())
                && trace.flush
                && trace.size_proof
                && trace.rewind
                && trace.same_handle_readback
                && trace.release_original
                && trace.reopen
                && trace.reopened_identity
                && trace.reopened_readback
                && trace.release_reopened
                && trace.acknowledgment
                && trace.release_root_ancestors
            {
                CreateClassification::Known
            } else {
                CreateClassification::UnknownPostCreate
            }
        }
    }
}

#[cfg(windows)]
#[derive(Clone, Debug, Eq, PartialEq)]
enum NativeCreateResult {
    Known {
        created: FileIdentity,
        same_handle_sha256: String,
        reopened: Box<FileIdentity>,
        reopened_sha256: String,
    },
    RefusedCollision,
    RefusedPreEffect,
    UnknownPreEffect,
    UnknownPostCreate,
}

#[cfg(windows)]
fn prepare_held_ancestors(root: &str, target: &str, binding: &DriveBinding) -> Result<Vec<HeldAncestor>, ProofFailure> {
    let paths = root_and_ancestor_paths(root, target)?;
    let mut held = Vec::with_capacity(paths.len());
    for path in &paths {
        let mut handle = match open_directory(path) {
            Ok(handle) => handle,
            Err(error) => {
                let incomplete_chain = !held.is_empty();
                return if release_all(&mut held).is_err() || incomplete_chain {
                    Err(ProofFailure::Incomplete)
                } else {
                    Err(error)
                };
            }
        };
        let identity = match query_identity(handle.raw, binding) {
            Ok(identity) => identity,
            Err(error) => {
                return Err(finalize_failed_prepare(&mut handle, &mut held, error));
            }
        };
        if !identity.directory {
            return Err(finalize_failed_prepare(
                &mut handle,
                &mut held,
                ProofFailure::DeterministicDrift,
            ));
        }
        if let Err(error) = validate_exact_opened_final_path(path, &identity.contract.final_path) {
            return Err(finalize_failed_prepare(&mut handle, &mut held, error));
        }
        if let Some(root_ancestor) = held.first() {
            if identity.contract.volume_serial_number
                != root_ancestor.initial.identity.volume_serial_number
            {
                return Err(finalize_failed_prepare(
                    &mut handle,
                    &mut held,
                    ProofFailure::DeterministicDrift,
                ));
            }
            match validate_final_containment(
                &root_ancestor.initial.identity.final_path,
                &identity.contract.final_path,
            ) {
                FinalContainment::Contained => {}
                FinalContainment::NonIdentical => {
                    return Err(finalize_failed_prepare(
                        &mut handle,
                        &mut held,
                        ProofFailure::NonIdenticalSpelling,
                    ));
                }
                FinalContainment::Invalid => {
                    return Err(finalize_failed_prepare(
                        &mut handle,
                        &mut held,
                        ProofFailure::DeterministicDrift,
                    ));
                }
            }
        }
        let initial = StableAncestorBinding {
            handle_id: handle.handle_id(),
            identity: identity.stable_ancestor(),
        };
        held.push(HeldAncestor { handle, initial });
    }
    Ok(held)
}

#[cfg(windows)]
fn ancestors_unchanged(held: &[HeldAncestor], binding: &DriveBinding) -> Result<(), ProofFailure> {
    let initial = held
        .iter()
        .map(|ancestor| ancestor.initial.clone())
        .collect::<Vec<_>>();
    let current = held
        .iter()
        .map(|ancestor| {
            query_identity(ancestor.handle.raw, binding).map(|identity| StableAncestorBinding {
                handle_id: ancestor.handle.handle_id(),
                identity: identity.stable_ancestor(),
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    validate_stable_ancestor_binding_revalidation(&initial, &current)
}

#[cfg(windows)]
fn open_created_target(path: &str) -> HANDLE {
    let path = wide_native_dos_path(path);
    // SAFETY: the canonical path is NUL-terminated; a successful handle is immediately owned by the caller.
    unsafe {
        CreateFileW(
            path.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            null(),
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    }
}

#[cfg(windows)]
fn reopen_created_target(path: &str) -> Result<OwnedHandle, ProofFailure> {
    let path = wide_native_dos_path(path);
    // SAFETY: the canonical path is NUL-terminated and ownership is transferred on success.
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            GENERIC_READ | FILE_READ_ATTRIBUTES,
            0,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    OwnedHandle::new(handle)
}

#[cfg(windows)]
fn release_create_handles(
    original: Option<&mut OwnedHandle>,
    reopened: Option<&mut OwnedHandle>,
    held: &mut [HeldAncestor],
) -> bool {
    let mut failed = false;
    if let Some(handle) = reopened {
        failed |= handle.close().is_err();
    }
    if let Some(handle) = original {
        failed |= handle.close().is_err();
    }
    failed |= release_all(held).is_err();
    failed
}

#[cfg(windows)]
fn execute_native_create(
    root: &str,
    target: &str,
    content: &[u8],
    deadline: std::time::Instant,
    binding: &DriveBinding,
) -> NativeCreateResult {
    let mut held = match prepare_held_ancestors(root, target, binding) {
        Ok(value) => value,
        Err(ProofFailure::DeterministicDrift) => return NativeCreateResult::RefusedPreEffect,
        Err(ProofFailure::NonIdenticalSpelling | ProofFailure::Incomplete) => {
            return NativeCreateResult::UnknownPreEffect;
        }
    };
    if std::time::Instant::now() >= deadline {
        let _held_close_failed = release_all(&mut held).is_err();
        return NativeCreateResult::UnknownPreEffect;
    }
    let raw = open_created_target(target);
    if raw == INVALID_HANDLE_VALUE {
        // SAFETY: this is the required immediate capture after the conclusive INVALID_HANDLE_VALUE result.
        let error = unsafe { GetLastError() };
        let revalidation_failed = ancestors_unchanged(&held, binding).is_err();
        let close_failed = release_all(&mut held).is_err();
        let classification = classify_create_open_error_after_release(
            error,
            close_failed || revalidation_failed,
            std::time::Instant::now() >= deadline,
        );
        return match classification {
            CreateClassification::RefusedCollision => NativeCreateResult::RefusedCollision,
            CreateClassification::RefusedPreEffect => NativeCreateResult::RefusedPreEffect,
            CreateClassification::UnknownPreEffect => NativeCreateResult::UnknownPreEffect,
            CreateClassification::UnknownPostCreate => NativeCreateResult::UnknownPostCreate,
            _ => unreachable!("open error classifier returned an impossible post-release state"),
        };
    }
    if raw.is_null() {
        let _held_close_failed = release_all(&mut held).is_err();
        return NativeCreateResult::UnknownPostCreate;
    }
    let mut original = match OwnedHandle::new(raw) {
        Ok(handle) => handle,
        Err(_) => {
            let _held_close_failed = release_all(&mut held).is_err();
            return NativeCreateResult::UnknownPostCreate;
        }
    };

    if !content.is_empty() && std::time::Instant::now() >= deadline {
        let _close_failed = release_create_handles(Some(&mut original), None, &mut held);
        return NativeCreateResult::UnknownPostCreate;
    }
    let mut written = 0u32;
    // SAFETY: `content.as_ptr()` is valid for the requested length, including the mandated zero request.
    let write_result = unsafe {
        WriteFile(
            original.raw,
            content.as_ptr(),
            content.len() as u32,
            &mut written,
            null_mut(),
        )
    };
    if content.is_empty() {
        let _deadline_expired_after_mandated_zero_write = std::time::Instant::now() >= deadline;
        let _close_failed = release_create_handles(Some(&mut original), None, &mut held);
        return NativeCreateResult::UnknownPostCreate;
    }
    if write_result == 0 || written as usize != content.len() {
        let _close_failed = release_create_handles(Some(&mut original), None, &mut held);
        return NativeCreateResult::UnknownPostCreate;
    }
    if std::time::Instant::now() >= deadline {
        let _close_failed = release_create_handles(Some(&mut original), None, &mut held);
        return NativeCreateResult::UnknownPostCreate;
    }
    // SAFETY: the valid original handle remains uniquely owned and open.
    if unsafe { FlushFileBuffers(original.raw) } == 0 {
        let _close_failed = release_create_handles(Some(&mut original), None, &mut held);
        return NativeCreateResult::UnknownPostCreate;
    }
    let created = match query_identity(original.raw, binding) {
        Ok(identity) if !identity.directory => identity.contract,
        _ => {
            let _close_failed = release_create_handles(Some(&mut original), None, &mut held);
            return NativeCreateResult::UnknownPostCreate;
        }
    };
    if created.size.parse::<usize>().ok() != Some(content.len())
        || created.volume_serial_number != held[0].initial.identity.volume_serial_number
        || validate_exact_target_final_path(
            root,
            target,
            &held[0].initial.identity.final_path,
            &created.final_path,
        )
        .is_err()
    {
        let _close_failed = release_create_handles(Some(&mut original), None, &mut held);
        return NativeCreateResult::UnknownPostCreate;
    }
    // SAFETY: this is the one required synchronous rewind on the valid original handle.
    if unsafe { SetFilePointerEx(original.raw, 0, null_mut(), FILE_BEGIN) } == 0 {
        let _close_failed = release_create_handles(Some(&mut original), None, &mut held);
        return NativeCreateResult::UnknownPostCreate;
    }
    let same_handle = match read_exact_handle(original.raw, content.len(), deadline) {
        Ok(bytes) if bytes == content => bytes,
        _ => {
            let _close_failed = release_create_handles(Some(&mut original), None, &mut held);
            return NativeCreateResult::UnknownPostCreate;
        }
    };
    let after_read = match query_identity(original.raw, binding) {
        Ok(identity) if !identity.directory => identity.contract,
        Err(_) => {
            let _close_failed = release_create_handles(Some(&mut original), None, &mut held);
            return NativeCreateResult::UnknownPostCreate;
        }
        Ok(_) => {
            let _close_failed = release_create_handles(Some(&mut original), None, &mut held);
            return NativeCreateResult::UnknownPostCreate;
        }
    };
    let same_handle_proof_failed = validate_exact_target_final_path(
        root,
        target,
        &held[0].initial.identity.final_path,
        &after_read.final_path,
    )
    .is_err()
        || after_read != created;
    let original_close_failed = original.close().is_err();
    if same_handle_proof_failed || original_close_failed {
        let _held_close_failed = release_all(&mut held).is_err();
        return NativeCreateResult::UnknownPostCreate;
    }

    if std::time::Instant::now() >= deadline {
        let _held_close_failed = release_all(&mut held).is_err();
        return NativeCreateResult::UnknownPostCreate;
    }

    let mut reopened_handle = match reopen_created_target(target) {
        Ok(handle) => handle,
        Err(_) => {
            let _held_close_failed = release_all(&mut held).is_err();
            return NativeCreateResult::UnknownPostCreate;
        }
    };
    let reopened = match query_identity(reopened_handle.raw, binding) {
        Ok(identity) if !identity.directory => identity.contract,
        _ => {
            let _close_failed = release_create_handles(None, Some(&mut reopened_handle), &mut held);
            return NativeCreateResult::UnknownPostCreate;
        }
    };
    if validate_exact_target_final_path(
        root,
        target,
        &held[0].initial.identity.final_path,
        &reopened.final_path,
    )
    .is_err()
    {
        let _close_failed = release_create_handles(None, Some(&mut reopened_handle), &mut held);
        return NativeCreateResult::UnknownPostCreate;
    }
    let reopened_content = match read_exact_handle(reopened_handle.raw, content.len(), deadline) {
        Ok(bytes) if bytes == content => bytes,
        _ => {
            let _close_failed = release_create_handles(None, Some(&mut reopened_handle), &mut held);
            return NativeCreateResult::UnknownPostCreate;
        }
    };
    let proof_failed = std::time::Instant::now() >= deadline
        || reopened != created
        || ancestors_unchanged(&held, binding).is_err();
    let close_failed = release_create_handles(None, Some(&mut reopened_handle), &mut held);
    if proof_failed || close_failed {
        return NativeCreateResult::UnknownPostCreate;
    }
    NativeCreateResult::Known {
        created,
        same_handle_sha256: sha256_lower(&same_handle),
        reopened: Box::new(reopened),
        reopened_sha256: sha256_lower(&reopened_content),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DeadlineContext {
    pub aggregate_deadline_ms: u64,
    pub operation_deadline_ms: u64,
}

impl DeadlineContext {
    pub fn new(aggregate_start_ms: u64, operation_start_ms: u64) -> Result<Self, &'static str> {
        let aggregate_deadline_ms = aggregate_start_ms
            .checked_add(AGGREGATE_DEADLINE_MS)
            .ok_or("aggregate deadline overflow")?;
        let operation_deadline_ms = operation_start_ms
            .checked_add(OPERATION_DEADLINE_MS)
            .ok_or("operation deadline overflow")?;
        if aggregate_deadline_ms > MAX_SAFE_INTEGER || operation_deadline_ms > MAX_SAFE_INTEGER {
            return Err("deadline exceeds the safe-integer domain");
        }
        Ok(Self {
            aggregate_deadline_ms,
            operation_deadline_ms,
        })
    }

    pub fn earliest(&self) -> u64 {
        self.aggregate_deadline_ms.min(self.operation_deadline_ms)
    }

    pub fn expired(&self, now_ms: u64) -> bool {
        now_ms >= self.earliest()
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct TerminationRequestLatch {
    requested: bool,
}

impl TerminationRequestLatch {
    pub fn request(&mut self) -> Result<(), &'static str> {
        if self.requested {
            return Err("termination request already issued");
        }
        self.requested = true;
        Ok(())
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct HandleLedger {
    owned: HashSet<String>,
}

impl HandleLedger {
    pub fn acquire(&mut self, kind: &str) -> Result<(), &'static str> {
        if !matches!(
            kind,
            "root" | "existing-ancestor" | "read-target" | "created-original" | "reopened-target"
        ) || !self.owned.insert(kind.to_owned())
        {
            return Err("unknown or already-owned handle kind");
        }
        Ok(())
    }

    pub fn close(&mut self, kind: &str) -> Result<(), &'static str> {
        if !self.owned.remove(kind) {
            return Err("handle is not owned or was already closed");
        }
        Ok(())
    }

    pub fn all_released(&self) -> bool {
        self.owned.is_empty()
    }
}

pub fn validate_request_semantics(
    request: &CanonicalRequest,
    canonical_bytes: usize,
) -> Result<(), &'static str> {
    let derived_canonical_bytes = canonical_request_bytes(request).len();
    if canonical_bytes != derived_canonical_bytes {
        return Err("caller-supplied canonical request length differs");
    }
    let maximum = match request.operation() {
        "read-bound-file" => 65_536,
        "create-new-durable-file" => 393_216,
        _ => return Err("operation is not admitted"),
    };
    if derived_canonical_bytes == 0 || derived_canonical_bytes > maximum {
        return Err("request exceeds its operation-specific cap");
    }
    if !validate_request_id(request.request_id()) {
        return Err("requestId differs from the uppercase UUID-v4 grammar");
    }
    validate_input_path_pair(request.root_path(), request.target_path())?;
    if let Some(content_base64) = request.content_base64() {
        decode_canonical_base64(content_base64, 262_144)?;
    }
    Ok(())
}

fn acknowledgment_value(
    request: &CanonicalRequest,
    request_sha256: &str,
    observation: &Value,
) -> Result<Value, &'static str> {
    let observation_bytes = canonical_json_bytes(observation)?;
    if observation_bytes.len() > 1_048_576 {
        return Err("observation exceeds its cap");
    }
    Ok(serde_json::json!({
        "schema": ACKNOWLEDGMENT_SCHEMA,
        "version": VERSION,
        "consumer": CONSUMER,
        "operation": request.operation(),
        "requestId": request.request_id(),
        "requestSha256": request_sha256,
        "observationUtf8Bytes": observation_bytes.len(),
        "observationSha256": sha256_lower(&observation_bytes),
        "outcome": "known"
    }))
}

pub fn read_success_values(
    request: &CanonicalRequest,
    request_sha256: &str,
    identity_before: &FileIdentity,
    identity_after: &FileIdentity,
    content: &[u8],
) -> Result<(Value, Value), &'static str> {
    let canonical_request = canonical_request_bytes(request);
    if request.operation() != "read-bound-file"
        || validate_request_semantics(request, canonical_request.len()).is_err()
        || request_sha256 != sha256_lower(&canonical_request)
    {
        return Err("read success correlation differs");
    }
    let exact_root_final_path = format!("\\\\?\\{}", request.root_path());
    validate_exact_target_final_path(
        request.root_path(),
        request.target_path(),
        &exact_root_final_path,
        &identity_before.final_path,
    )
    .map_err(|_| "read target correlation differs")?;
    let (_, content_sha256) = complete_read_proof(
        &exact_root_final_path,
        identity_before,
        identity_after,
        content,
    )
    .map_err(|_| "read proof is incomplete")?;
    let observation = serde_json::json!({
        "schema": OBSERVATION_SCHEMA,
        "version": VERSION,
        "consumer": CONSUMER,
        "operation": "read-bound-file",
        "requestId": request.request_id(),
        "requestSha256": request_sha256,
        "identityBefore": identity_before.to_value(),
        "identityAfter": identity_after.to_value(),
        "contentBase64": STANDARD.encode(content),
        "contentSha256": content_sha256
    });
    let acknowledgment = acknowledgment_value(request, request_sha256, &observation)?;
    Ok((observation, acknowledgment))
}

fn read_success_values_with_root(
    request: &CanonicalRequest,
    request_sha256: &str,
    root_final_path: &str,
    identity_before: &FileIdentity,
    identity_after: &FileIdentity,
    content: &[u8],
) -> Result<(Value, Value), &'static str> {
    let canonical_request = canonical_request_bytes(request);
    if request.operation() != "read-bound-file"
        || validate_request_semantics(request, canonical_request.len()).is_err()
        || request_sha256 != sha256_lower(&canonical_request)
    {
        return Err("read success correlation differs");
    }
    validate_exact_target_final_path(
        request.root_path(),
        request.target_path(),
        root_final_path,
        &identity_before.final_path,
    )
    .map_err(|_| "read target correlation differs")?;
    complete_read_proof(root_final_path, identity_before, identity_after, content)
        .map_err(|_| "read proof is incomplete")?;
    let observation = serde_json::json!({
        "schema": OBSERVATION_SCHEMA,
        "version": VERSION,
        "consumer": CONSUMER,
        "operation": "read-bound-file",
        "requestId": request.request_id(),
        "requestSha256": request_sha256,
        "identityBefore": identity_before.to_value(),
        "identityAfter": identity_after.to_value(),
        "contentBase64": STANDARD.encode(content),
        "contentSha256": sha256_lower(content)
    });
    let acknowledgment = acknowledgment_value(request, request_sha256, &observation)?;
    Ok((observation, acknowledgment))
}

fn create_success_values(
    request: &CanonicalRequest,
    request_sha256: &str,
    created: &FileIdentity,
    same_handle_sha256: &str,
    reopened: &FileIdentity,
    reopened_sha256: &str,
) -> Result<(Value, Value), &'static str> {
    let canonical_request = canonical_request_bytes(request);
    if request.operation() != "create-new-durable-file"
        || validate_request_semantics(request, canonical_request.len()).is_err()
        || request_sha256 != sha256_lower(&canonical_request)
        || !validate_sha256(same_handle_sha256)
        || !validate_sha256(reopened_sha256)
        || same_handle_sha256 != reopened_sha256
    {
        return Err("create success correlation differs");
    }
    let content = decode_canonical_base64(
        request.content_base64().ok_or("create content is absent")?,
        262_144,
    )?;
    if content.is_empty()
        || created.size.parse::<usize>().ok() != Some(content.len())
        || created != reopened
        || sha256_lower(&content) != same_handle_sha256
    {
        return Err("create content or identity proof differs");
    }
    let observation = serde_json::json!({
        "schema": OBSERVATION_SCHEMA,
        "version": VERSION,
        "consumer": CONSUMER,
        "operation": "create-new-durable-file",
        "requestId": request.request_id(),
        "requestSha256": request_sha256,
        "creationDisposition": "CREATE_NEW",
        "creationFlags": [
            "FILE_ATTRIBUTE_NORMAL",
            "FILE_FLAG_WRITE_THROUGH",
            "FILE_FLAG_OPEN_REPARSE_POINT"
        ],
        "createdIdentity": created.to_value(),
        "flushFileBuffersSucceeded": true,
        "sameHandleReadbackSha256": same_handle_sha256,
        "reopenedIdentity": reopened.to_value(),
        "reopenedReadbackSha256": reopened_sha256
    });
    let acknowledgment = acknowledgment_value(request, request_sha256, &observation)?;
    Ok((observation, acknowledgment))
}

#[cfg(test)]
pub fn fixture_create_success_values(
    request: &CanonicalRequest,
    request_sha256: &str,
    created: &FileIdentity,
    same_handle_sha256: &str,
    reopened: &FileIdentity,
    reopened_sha256: &str,
) -> Result<(Value, Value), &'static str> {
    create_success_values(
        request,
        request_sha256,
        created,
        same_handle_sha256,
        reopened,
        reopened_sha256,
    )
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObserverRunResult {
    pub stdout: Vec<u8>,
    pub exit_code: i32,
}

fn terminal_run(value: Value) -> ObserverRunResult {
    match terminal_frame(&value) {
        Ok(stdout) => ObserverRunResult {
            stdout,
            exit_code: 0,
        },
        Err(_) => ObserverRunResult {
            stdout: Vec::new(),
            exit_code: 64,
        },
    }
}

fn correlated_run(
    request: &CanonicalRequest,
    request_sha256: &str,
    outcome: &str,
    failure_stage: &str,
    effect_state: &str,
) -> ObserverRunResult {
    correlated_fields_run(
        request.operation(),
        request.request_id(),
        request_sha256,
        outcome,
        failure_stage,
        effect_state,
    )
}

fn correlated_fields_run(
    operation: &str,
    request_id: &str,
    request_sha256: &str,
    outcome: &str,
    failure_stage: &str,
    effect_state: &str,
) -> ObserverRunResult {
    match correlated_terminal(
        operation,
        request_id,
        request_sha256,
        outcome,
        failure_stage,
        effect_state,
    ) {
        Ok(value) => terminal_run(value),
        Err(_) => ObserverRunResult {
            stdout: Vec::new(),
            exit_code: 64,
        },
    }
}

pub fn run_observer(arguments: &[String], input: &[u8]) -> ObserverRunResult {
    run_observer_with_aggregate_start(arguments, input, std::time::Instant::now())
}

pub fn run_observer_with_aggregate_start(
    arguments: &[String],
    input: &[u8],
    aggregate_started: std::time::Instant,
) -> ObserverRunResult {
    // vars_os takes one original-pair-preserving Windows snapshot. Never use var()/a map:
    // both could hide a duplicate or case alias. Lookup occurs only after request semantics.
    run_observer_with_environment_provider(arguments, input, aggregate_started, std::env::vars_os)
}

#[cfg(test)]
pub fn run_observer_with_fixture_environment(
    arguments: &[String],
    input: &[u8],
    aggregate_started: std::time::Instant,
    snapshot: impl FnOnce() -> Vec<(std::ffi::OsString, std::ffi::OsString)>,
) -> ObserverRunResult {
    run_observer_with_environment_provider(arguments, input, aggregate_started, snapshot)
}

fn run_observer_with_environment_provider<I>(
    arguments: &[String],
    input: &[u8],
    aggregate_started: std::time::Instant,
    snapshot: impl FnOnce() -> I,
) -> ObserverRunResult
where
    I: IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
{
    if !validate_cli_args(arguments) {
        return ObserverRunResult {
            stdout: Vec::new(),
            exit_code: 64,
        };
    }
    if input.len() > 393_216 {
        return terminal_run(pre_observation_refusal());
    }
    let aggregate_deadline = match aggregate_started
        .checked_add(std::time::Duration::from_millis(AGGREGATE_DEADLINE_MS))
    {
        Some(deadline) => deadline,
        None => return terminal_run(pre_observation_refusal()),
    };
    let correlation_seed = canonical_correlation_seed(input);
    let request = match parse_canonical_request(input) {
        Ok(request) => request,
        Err(_) => {
            return match correlation_seed {
                Some((operation, request_id, request_sha256)) => correlated_fields_run(
                    &operation,
                    &request_id,
                    &request_sha256,
                    "refused",
                    "pre-effect",
                    "none",
                ),
                None => terminal_run(pre_observation_refusal()),
            };
        }
    };
    let request_sha256 = sha256_lower(input);
    if validate_request_semantics(&request, input.len()).is_err() {
        return match correlation_seed {
            Some((operation, request_id, correlated_sha256)) => correlated_fields_run(
                &operation,
                &request_id,
                &correlated_sha256,
                "refused",
                "pre-effect",
                "none",
            ),
            None => terminal_run(pre_observation_refusal()),
        };
    }
    let operation_started = std::time::Instant::now();
    let operation_deadline = match operation_started
        .checked_add(std::time::Duration::from_millis(OPERATION_DEADLINE_MS))
    {
        Some(deadline) => deadline,
        None => {
            return correlated_run(&request, &request_sha256, "unknown", "pre-effect", "none");
        }
    };
    let earliest_deadline = aggregate_deadline.min(operation_deadline);
    if operation_started >= earliest_deadline {
        return correlated_run(&request, &request_sha256, "unknown", "pre-effect", "none");
    }
    let binding = match drive_binding_from_snapshot(
        snapshot(), &request_sha256, &request.root_path()[..2],
    ) {
        Ok(binding) => binding,
        Err(_) => return correlated_run(&request, &request_sha256, "unknown", "pre-effect", "none"),
    };
    if std::time::Instant::now() >= earliest_deadline {
        return correlated_run(&request, &request_sha256, "unknown", "pre-effect", "none");
    }
    #[cfg(not(windows))]
    let _ = &binding;
    #[cfg(windows)]
    let result = match request.operation() {
        "read-bound-file" => {
            match execute_native_read(
                request.root_path(),
                request.target_path(),
                earliest_deadline,
                &binding,
            ) {
                NativeReadResult::Known {
                    held_root_final_path,
                    before,
                    after,
                    content,
                } => {
                    match read_success_values_with_root(
                        &request,
                        &request_sha256,
                        &held_root_final_path,
                        &before,
                        &after,
                        &content,
                    ) {
                        Ok((observation, acknowledgment)) => {
                            if std::time::Instant::now() >= earliest_deadline {
                                correlated_run(
                                    &request,
                                    &request_sha256,
                                    "unknown",
                                    "read-observation",
                                    "none",
                                )
                            } else {
                                let frame = success_frame(&observation, &acknowledgment);
                                let frame = finalize_success_frame(
                                    frame,
                                    std::time::Instant::now() >= earliest_deadline,
                                );
                                match frame {
                                    Ok(stdout) => ObserverRunResult {
                                        stdout,
                                        exit_code: 0,
                                    },
                                    Err(_) => correlated_run(
                                        &request,
                                        &request_sha256,
                                        "unknown",
                                        "read-observation",
                                        "none",
                                    ),
                                }
                            }
                        }
                        Err(_) => correlated_run(
                            &request,
                            &request_sha256,
                            "unknown",
                            "read-observation",
                            "none",
                        ),
                    }
                }
                NativeReadResult::RefusedPreEffect => {
                    correlated_run(&request, &request_sha256, "refused", "pre-effect", "none")
                }
                NativeReadResult::UnknownPreEffect => {
                    correlated_run(&request, &request_sha256, "unknown", "pre-effect", "none")
                }
                NativeReadResult::RefusedReadObservation => correlated_run(
                    &request,
                    &request_sha256,
                    "refused",
                    "read-observation",
                    "none",
                ),
                NativeReadResult::UnknownReadObservation => correlated_run(
                    &request,
                    &request_sha256,
                    "unknown",
                    "read-observation",
                    "none",
                ),
            }
        }
        "create-new-durable-file" => {
            let content = decode_canonical_base64(
                request.content_base64().expect("validated create content"),
                262_144,
            )
            .expect("validated create Base64");
            match execute_native_create(
                request.root_path(),
                request.target_path(),
                &content,
                earliest_deadline,
                &binding,
            ) {
                NativeCreateResult::Known {
                    created,
                    same_handle_sha256,
                    reopened,
                    reopened_sha256,
                } => match create_success_values(
                    &request,
                    &request_sha256,
                    &created,
                    &same_handle_sha256,
                    &reopened,
                    &reopened_sha256,
                ) {
                    Ok((observation, acknowledgment))
                        if std::time::Instant::now() < earliest_deadline =>
                    {
                        let frame = success_frame(&observation, &acknowledgment);
                        let frame = finalize_success_frame(
                            frame,
                            std::time::Instant::now() >= earliest_deadline,
                        );
                        match frame {
                            Ok(stdout) => ObserverRunResult {
                                stdout,
                                exit_code: 0,
                            },
                            Err(_) => correlated_run(
                                &request,
                                &request_sha256,
                                "unknown",
                                "post-create",
                                "possibly-created",
                            ),
                        }
                    }
                    _ => correlated_run(
                        &request,
                        &request_sha256,
                        "unknown",
                        "post-create",
                        "possibly-created",
                    ),
                },
                NativeCreateResult::RefusedCollision => correlated_run(
                    &request,
                    &request_sha256,
                    "refused",
                    "create-collision",
                    "not-created",
                ),
                NativeCreateResult::RefusedPreEffect => {
                    correlated_run(&request, &request_sha256, "refused", "pre-effect", "none")
                }
                NativeCreateResult::UnknownPreEffect => {
                    correlated_run(&request, &request_sha256, "unknown", "pre-effect", "none")
                }
                NativeCreateResult::UnknownPostCreate => correlated_run(
                    &request,
                    &request_sha256,
                    "unknown",
                    "post-create",
                    "possibly-created",
                ),
            }
        }
        _ => unreachable!("canonical request operation was validated"),
    };
    #[cfg(not(windows))]
    let result = correlated_run(&request, &request_sha256, "unknown", "pre-effect", "none");
    result
}

fn main() {
    use std::io::{Read as _, Write as _};

    let aggregate_started = std::time::Instant::now();
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    let mut input = Vec::new();
    if std::io::stdin()
        .take(393_217)
        .read_to_end(&mut input)
        .is_err()
    {
        std::process::exit(64);
    }
    let result = run_observer_with_aggregate_start(&arguments, &input, aggregate_started);
    if !result.stdout.is_empty() {
        let mut stdout = std::io::stdout().lock();
        if stdout.write_all(&result.stdout).is_err() || stdout.flush().is_err() {
            std::process::exit(64);
        }
    }
    std::process::exit(result.exit_code);
}
