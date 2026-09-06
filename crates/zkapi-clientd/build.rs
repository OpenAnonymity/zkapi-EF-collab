use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
    {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "cjs" => "application/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "wasm" => "application/wasm",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn collect_files(root: &Path, dir: &Path, files: &mut Vec<(String, PathBuf)>) {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .expect("read funding-page directory")
        .filter_map(Result::ok)
        .collect();
    entries.sort_by_key(|entry| entry.path());

    for entry in entries {
        let path = entry.path();
        let file_type = entry.file_type().expect("read funding-page file type");
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            collect_files(root, &path, files);
        } else if file_type.is_file() {
            let relative = path
                .strip_prefix(root)
                .expect("funding asset under root")
                .to_string_lossy()
                .replace('\\', "/");
            files.push((relative, path));
        }
    }
}

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let repo_root = manifest
        .join("../..")
        .canonicalize()
        .expect("repository root");
    let output_dir = PathBuf::from(std::env::var("OUT_DIR").expect("out dir"));
    // Both the daemon and hosted browser build use the same OA composition pipeline.
    // Never fall back to embedding the old vendored source tree.
    for input in [
        "funding-page",
        "oa-chat/chat",
        "oa-chat/nanomem/src",
        "oa-chat/nanomem/browser.js",
        "scripts/compose-browser-client.mjs",
        "browser-sources.lock.json",
        "package.json",
        "package-lock.json",
        "protocol/setup/v2",
    ] {
        println!("cargo:rerun-if-changed={}", repo_root.join(input).display());
    }
    println!("cargo:rerun-if-env-changed=NODE");
    let node = std::env::var_os("NODE").unwrap_or_else(|| "node".into());
    let output_root = output_dir.join("composed-ui");
    let status = Command::new(node)
        .arg(repo_root.join("scripts/compose-browser-client.mjs"))
        .arg("--out-dir")
        .arg(&output_root)
        .arg("--network")
        .arg("sepolia")
        .current_dir(&repo_root)
        .status()
        .expect("Run npm ci and install Node.js 24+ before compiling zkapi-clientd");
    assert!(status.success(), "OA Chat composition failed. Run npm ci and git submodule update --init --recursive, then retry.");
    let root = output_root.join("funding");

    let mut files = Vec::new();
    collect_files(&root, &root, &mut files);

    let mut generated = String::from(
        "pub(crate) fn embedded_funding_asset(path: &str) -> Option<(&'static [u8], &'static str)> {\n    match path {\n",
    );
    for (relative, absolute) in files {
        let absolute = absolute.canonicalize().expect("canonical funding asset");
        generated.push_str(&format!(
            "        {:?} => Some((include_bytes!({:?}), {:?})),\n",
            relative,
            absolute.to_string_lossy(),
            content_type(&absolute)
        ));
    }
    generated.push_str("        _ => None,\n    }\n}\n");

    let output = output_dir.join("embedded_funding_assets.rs");
    fs::write(output, generated).expect("write embedded funding asset map");
}
