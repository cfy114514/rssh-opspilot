//! Private, ephemeral discovery records for the local MCP stdio adapter.
//! A separate file per bridge prevents an old bridge's cleanup from deleting a
//! newer bridge's record. A crashed process leaves only an unusable token.
use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryInfo {
    pub bridge_id: String,
    pub endpoint: String,
    pub token: String,
}

pub struct Registration(PathBuf);
impl Drop for Registration {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn discovery_dir() -> io::Result<PathBuf> {
    dirs::home_dir()
        .map(|home| home.join(".rssh").join("mcp-discovery"))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "home directory unavailable"))
}

#[cfg(unix)]
fn ensure_private_dir(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
        let meta = std::fs::symlink_metadata(parent)?;
        if !meta.is_dir()
            || meta.uid() != unsafe { libc::geteuid() }
            || meta.permissions().mode() & 0o022 != 0
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "MCP discovery parent must be owned by the current user and not writable by others",
            ));
        }
    }
    let mut builder = std::fs::DirBuilder::new();
    builder.mode(0o700);
    match builder.create(path) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    let meta = std::fs::symlink_metadata(path)?;
    if !meta.is_dir()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.permissions().mode() & 0o077 != 0
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "MCP discovery directory must be private",
        ));
    }
    Ok(())
}

#[cfg(unix)]
pub fn publish_at(dir: &Path, info: &DiscoveryInfo) -> io::Result<Registration> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    ensure_private_dir(dir)?;
    let id = uuid::Uuid::parse_str(&info.bridge_id)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid bridge id"))?;
    let path = dir.join(format!("{id}.json"));
    let temp = dir.join(format!(".{id}.tmp"));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&temp)?;
    if let Err(error) = serde_json::to_writer(&mut file, info)
        .map_err(io::Error::other)
        .and_then(|()| file.flush())
    {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    if let Err(error) = std::fs::rename(&temp, &path) {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    Ok(Registration(path))
}

#[cfg(unix)]
pub fn publish(info: &DiscoveryInfo) -> io::Result<Registration> {
    publish_at(&discovery_dir()?, info)
}

#[cfg(unix)]
pub fn candidates_at(dir: &Path) -> io::Result<Vec<DiscoveryInfo>> {
    use std::io::Read;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
    let parent = dir
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing discovery parent"))?;
    let parent_meta = std::fs::symlink_metadata(parent)?;
    if !parent_meta.is_dir()
        || parent_meta.uid() != unsafe { libc::geteuid() }
        || parent_meta.permissions().mode() & 0o022 != 0
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "MCP discovery parent must be private from other users",
        ));
    }
    let meta = std::fs::symlink_metadata(dir)?;
    if !meta.is_dir()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.permissions().mode() & 0o077 != 0
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "MCP discovery directory must be private",
        ));
    }
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if !meta.is_file()
            || meta.uid() != unsafe { libc::geteuid() }
            || meta.permissions().mode() & 0o077 != 0
            || meta.len() > 4096
        {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(stem) = name.strip_suffix(".json") else {
            continue;
        };
        if uuid::Uuid::parse_str(stem).is_err() {
            continue;
        }
        let Ok(file) = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(entry.path())
        else {
            continue;
        };
        let Ok(opened) = file.metadata() else {
            continue;
        };
        if !opened.is_file()
            || opened.uid() != unsafe { libc::geteuid() }
            || opened.permissions().mode() & 0o077 != 0
            || opened.len() > 4096
        {
            continue;
        }
        let mut bytes = Vec::new();
        if file.take(4097).read_to_end(&mut bytes).is_err() || bytes.len() > 4096 {
            continue;
        }
        let Ok(info) = serde_json::from_slice::<DiscoveryInfo>(&bytes) else {
            continue;
        };
        if info.bridge_id != stem {
            continue;
        }
        entries.push((meta.modified().ok(), info));
    }
    entries.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(entries.into_iter().map(|(_, info)| info).collect())
}

#[cfg(unix)]
pub fn candidates() -> io::Result<Vec<DiscoveryInfo>> {
    candidates_at(&discovery_dir()?)
}

#[cfg(not(unix))]
pub fn publish(_info: &DiscoveryInfo) -> io::Result<Registration> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "MCP discovery is not supported on this platform",
    ))
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    #[test]
    fn rejects_public_directories_and_ignores_symlink_records() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("private");
        let info = DiscoveryInfo {
            bridge_id: uuid::Uuid::new_v4().to_string(),
            endpoint: "http://127.0.0.1:1234/mcp".into(),
            token: "secret".into(),
        };
        let registration = publish_at(&dir, &info).unwrap();
        let link = dir.join(format!("{}.json", uuid::Uuid::new_v4()));
        symlink(&registration.0, &link).unwrap();
        assert_eq!(candidates_at(&dir).unwrap().len(), 1);
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(candidates_at(&dir).is_err());
        assert!(publish_at(
            &dir,
            &DiscoveryInfo {
                bridge_id: uuid::Uuid::new_v4().to_string(),
                ..info
            }
        )
        .is_err());
    }

    #[test]
    fn records_are_private_and_cleanup_is_scoped() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("private");
        let make = || DiscoveryInfo {
            bridge_id: uuid::Uuid::new_v4().to_string(),
            endpoint: "http://127.0.0.1:1234/mcp".into(),
            token: "token".into(),
        };
        let a = make();
        let b = make();
        let one = publish_at(&dir, &a).unwrap();
        let two = publish_at(&dir, &b).unwrap();
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&one.0).unwrap().permissions().mode() & 0o777,
            0o600
        );
        drop(one);
        let candidates = candidates_at(&dir).unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].bridge_id, b.bridge_id);
        drop(two);
        assert!(candidates_at(&dir).unwrap().is_empty());
    }
}
