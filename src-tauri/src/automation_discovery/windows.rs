//! Windows discovery records are created with an explicit protected DACL.
//! Validation operates on opened handles, and rejects reparse points.
use super::{discovery_dir, DiscoveryInfo, Registration};
use std::ffi::{c_void, OsStr};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::Path;
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo,
    SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    AclSizeInformation, GetAce, GetAclInformation, GetSecurityDescriptorControl,
    GetTokenInformation, TokenUser, ACCESS_ALLOWED_ACE, ACL, ACL_SIZE_INFORMATION,
    DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
    SECURITY_ATTRIBUTES, SE_DACL_PROTECTED, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateDirectoryW, CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    CREATE_NEW, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, OPEN_EXISTING, READ_CONTROL,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}
fn fail() -> io::Error {
    io::Error::last_os_error()
}

struct Local(*mut c_void);
impl Drop for Local {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

unsafe fn sid_text(sid: PSID) -> io::Result<String> {
    let mut result = null_mut();
    if ConvertSidToStringSidW(sid, &mut result) == 0 {
        return Err(fail());
    }
    let allocation = Local(result.cast());
    let mut len = 0;
    while *result.add(len) != 0 {
        len += 1;
    }
    let text = String::from_utf16_lossy(std::slice::from_raw_parts(result, len));
    drop(allocation);
    Ok(text)
}
fn user_sid() -> io::Result<String> {
    unsafe {
        let mut token = null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(fail());
        }
        let mut len = 0;
        GetTokenInformation(token, TokenUser, null_mut(), 0, &mut len);
        if len == 0 {
            CloseHandle(token);
            return Err(fail());
        }
        let mut buffer = vec![
            0usize;
            (len as usize + std::mem::size_of::<usize>() - 1)
                / std::mem::size_of::<usize>()
        ];
        let ok = GetTokenInformation(token, TokenUser, buffer.as_mut_ptr().cast(), len, &mut len);
        CloseHandle(token);
        if ok == 0 {
            return Err(fail());
        }
        sid_text((*(buffer.as_ptr() as *const TOKEN_USER)).User.Sid)
    }
}
fn descriptor(user: &str) -> io::Result<Local> {
    // O: fixes the owner even for elevated processes; P disables inheritance.
    let sddl = format!("O:{user}D:P(A;;FA;;;{user})(A;;FA;;;SY)");
    let mut result: PSECURITY_DESCRIPTOR = null_mut();
    let encoded = wide(OsStr::new(&sddl));
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            encoded.as_ptr(),
            1,
            &mut result,
            null_mut(),
        )
    } == 0
    {
        return Err(fail());
    }
    Ok(Local(result))
}
fn open(path: &Path, directory: bool, write: bool, sd: Option<&Local>) -> io::Result<File> {
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd.map_or(null_mut(), |s| s.0),
        bInheritHandle: 0,
    };
    let access = if write {
        windows_sys::Win32::Foundation::GENERIC_WRITE | READ_CONTROL
    } else {
        FILE_GENERIC_READ | READ_CONTROL
    };
    let flags = FILE_FLAG_OPEN_REPARSE_POINT
        | if directory {
            FILE_FLAG_BACKUP_SEMANTICS
        } else {
            0
        };
    let handle = unsafe {
        CreateFileW(
            wide(path.as_os_str()).as_ptr(),
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            if sd.is_some() {
                &mut attributes
            } else {
                null_mut()
            },
            if write { CREATE_NEW } else { OPEN_EXISTING },
            flags,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(fail());
    }
    let file = unsafe { File::from_raw_handle(handle.cast()) };
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(handle, &mut info) } == 0 {
        return Err(fail());
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "MCP discovery reparse point rejected",
        ));
    }
    Ok(file)
}
fn validate(file: &File, user: &str) -> io::Result<()> {
    unsafe {
        let mut owner = null_mut();
        let mut dacl: *mut ACL = null_mut();
        let mut sd: PSECURITY_DESCRIPTOR = null_mut();
        let result = GetSecurityInfo(
            file.as_raw_handle().cast(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut sd,
        );
        if result != 0 {
            return Err(io::Error::from_raw_os_error(result as i32));
        }
        let _owned = Local(sd);
        let reject = || {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                "MCP discovery ACL is not private",
            )
        };
        if owner.is_null() || dacl.is_null() || sid_text(owner)? != user {
            return Err(reject());
        }
        let mut control = 0;
        let mut revision = 0;
        if GetSecurityDescriptorControl(sd, &mut control, &mut revision) == 0
            || control & SE_DACL_PROTECTED == 0
        {
            return Err(reject());
        }
        let mut size = ACL_SIZE_INFORMATION::default();
        if GetAclInformation(
            dacl,
            (&mut size as *mut ACL_SIZE_INFORMATION).cast(),
            std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        ) == 0
            || size.AceCount != 2
        {
            return Err(reject());
        }
        let mut seen_user = false;
        let mut seen_system = false;
        for i in 0..size.AceCount {
            let mut ptr = null_mut();
            if GetAce(dacl, i, &mut ptr) == 0 || ptr.is_null() {
                return Err(reject());
            }
            let ace = &*(ptr as *const ACCESS_ALLOWED_ACE);
            // ACCESS_ALLOWED_ACE_TYPE == 0; reject inherited/object/callback ACEs.
            if ace.Header.AceType != 0 || ace.Header.AceFlags != 0 || ace.Mask == 0 {
                return Err(reject());
            }
            let sid = sid_text((&ace.SidStart as *const u32).cast_mut().cast())?;
            if sid == user {
                seen_user = true;
            } else if sid == "S-1-5-18" {
                seen_system = true;
            } else {
                return Err(reject());
            }
        }
        if !seen_user || !seen_system {
            return Err(reject());
        }
    }
    Ok(())
}
pub fn publish_at(dir: &Path, info: &DiscoveryInfo) -> io::Result<Registration> {
    let user = user_sid()?;
    let sd = descriptor(&user)?;
    if let Some(parent) = dir.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut attrs = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd.0,
        bInheritHandle: 0,
    };
    if unsafe { CreateDirectoryW(wide(dir.as_os_str()).as_ptr(), &mut attrs) } == 0 {
        let e = fail();
        if e.kind() != io::ErrorKind::AlreadyExists {
            return Err(e);
        }
    }
    validate(&open(dir, true, false, None)?, &user)?;
    let id = uuid::Uuid::parse_str(&info.bridge_id)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid bridge id"))?;
    let path = dir.join(format!("{id}.json"));
    let temp = dir.join(format!(".{id}.tmp"));
    let mut file = open(&temp, false, true, Some(&sd))?;
    validate(&file, &user)?;
    if let Err(e) = serde_json::to_writer(&mut file, info)
        .map_err(io::Error::other)
        .and_then(|()| file.flush())
    {
        let _ = fs::remove_file(&temp);
        return Err(e);
    }
    drop(file);
    if let Err(e) = fs::rename(&temp, &path) {
        let _ = fs::remove_file(&temp);
        return Err(e);
    }
    Ok(Registration(path))
}
pub fn publish(info: &DiscoveryInfo) -> io::Result<Registration> {
    publish_at(&discovery_dir()?, info)
}
pub fn candidates_at(dir: &Path) -> io::Result<Vec<DiscoveryInfo>> {
    let user = user_sid()?;
    validate(&open(dir, true, false, None)?, &user)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(stem) = name.strip_suffix(".json") else {
            continue;
        };
        if uuid::Uuid::parse_str(stem).is_err() {
            continue;
        }
        let Ok(file) = open(&entry.path(), false, false, None) else {
            continue;
        };
        if validate(&file, &user).is_err() {
            continue;
        }
        let Ok(meta) = file.metadata() else { continue };
        if !meta.is_file() || meta.len() > 4096 {
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
pub fn candidates() -> io::Result<Vec<DiscoveryInfo>> {
    candidates_at(&discovery_dir()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_directory_granting_access_to_everyone() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("insecure");
        let user = user_sid().unwrap();
        let sddl = wide(OsStr::new(&format!(
            "O:{user}D:P(A;;FA;;;{user})(A;;FA;;;SY)(A;;FA;;;WD)"
        )));
        let mut raw: PSECURITY_DESCRIPTOR = null_mut();
        assert_ne!(
            unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    1,
                    &mut raw,
                    null_mut(),
                )
            },
            0
        );
        let sd = Local(raw);
        let mut attrs = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd.0,
            bInheritHandle: 0,
        };
        assert_ne!(
            unsafe { CreateDirectoryW(wide(dir.as_os_str()).as_ptr(), &mut attrs) },
            0
        );
        assert!(candidates_at(&dir).is_err());
        let info = DiscoveryInfo {
            bridge_id: uuid::Uuid::new_v4().to_string(),
            endpoint: "http://127.0.0.1:1234/mcp".into(),
            token: "secret".into(),
        };
        assert!(publish_at(&dir, &info).is_err());
    }

    #[test]
    fn isolated_records_are_private_and_revoked_independently() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("records");
        let make = || DiscoveryInfo {
            bridge_id: uuid::Uuid::new_v4().to_string(),
            endpoint: "http://127.0.0.1:1234/mcp".into(),
            token: "secret".into(),
        };
        let one = make();
        let two = make();
        let first = publish_at(&dir, &one).unwrap();
        let second = publish_at(&dir, &two).unwrap();
        assert_eq!(candidates_at(&dir).unwrap().len(), 2);
        drop(first);
        let found = candidates_at(&dir).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].bridge_id, two.bridge_id);
        drop(second);
        assert!(candidates_at(&dir).unwrap().is_empty());
    }
}
