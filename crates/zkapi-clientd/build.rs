use std::fs;
use std::path::{Path, PathBuf};

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
    let root = manifest.join("../../funding-page");
    println!("cargo:rerun-if-changed={}", root.display());

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

    let output = PathBuf::from(std::env::var("OUT_DIR").expect("out dir"))
        .join("embedded_funding_assets.rs");
    fs::write(output, generated).expect("write embedded funding asset map");
}
