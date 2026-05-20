/// Infrastructure smoke test — proves `tempfile` dev-dependency is wired correctly.
/// Run with: cargo test --manifest-path src-tauri/Cargo.toml --test infra_smoke

#[test]
fn tempdir_can_be_created() {
    let dir = tempfile::TempDir::new().expect("tempfile::TempDir::new() must succeed");
    assert!(dir.path().exists(), "TempDir path must exist on disk");
}

#[test]
fn tempfile_can_be_written_and_read() {
    use std::io::{Read, Write};
    let mut f = tempfile::NamedTempFile::new().expect("NamedTempFile::new() must succeed");
    let payload = b"ultimate-amv-infra-smoke";
    f.write_all(payload).expect("write must succeed");
    f.flush().expect("flush must succeed");

    // Re-open through the path to confirm bytes hit the OS
    let path = f.path().to_owned();
    let mut buf = Vec::new();
    std::fs::File::open(&path)
        .expect("re-open must succeed")
        .read_to_end(&mut buf)
        .expect("read must succeed");
    assert_eq!(buf, payload, "bytes read back must match bytes written");
}
