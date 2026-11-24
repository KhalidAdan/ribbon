//! Reading a file in as few requests as the work allows.
//!
//! A library is often a share across the internet, where every request for bytes is a
//! round trip and the bytes themselves are cheap. A RAR has no list of its files at one
//! end, as a zip has: each file's header sits in front of that file, so listing an
//! archive is a jump to every header. The RAR reader asks for a header in two or three
//! small reads and a page in chunks of a few kilobytes; left alone, that is hundreds of
//! requests for one page.
//!
//! So this reads ahead, the way a disk cache does. After a jump it fetches a little,
//! since a header is all that is wanted there. When the next read follows on from what
//! it holds, a file's bytes are being read through, and it fetches a megabyte at a time.
//! Listing costs one request for each file in the archive; a page costs two or three.

use std::io::{Read, Result, Seek, SeekFrom};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// What is fetched after a jump: more than any header, and far less than a page.
const AFTER_A_JUMP: usize = 16 * 1024;
/// What is fetched when reading carries on from the last fetch.
const CARRYING_ON: usize = 1 << 20;

/// A file read ahead of what is asked for. It holds one stretch of the file at a time.
pub struct ReadAhead<R> {
    inner: R,
    len: u64,
    /// Where the next read is.
    at: u64,
    /// Where the held stretch starts in the file.
    held_from: u64,
    held: Vec<u8>,
    requests: Arc<AtomicU64>,
}

impl<R: Read + Seek> ReadAhead<R> {
    pub fn new(mut inner: R) -> Result<Self> {
        let len = inner.seek(SeekFrom::End(0))?;
        Ok(Self { inner, len, at: 0, held_from: 0, held: Vec::new(), requests: Arc::new(AtomicU64::new(0)) })
    }

    /// How many times the file has been asked for bytes, counted as it goes: what a share
    /// makes slow, so what the tests hold down.
    pub fn requests(&self) -> Arc<AtomicU64> {
        self.requests.clone()
    }

    fn held_until(&self) -> u64 {
        self.held_from + self.held.len() as u64
    }

    fn fetch(&mut self) -> Result<()> {
        let carrying_on = !self.held.is_empty() && self.at == self.held_until();
        let want = (if carrying_on { CARRYING_ON } else { AFTER_A_JUMP }).min((self.len - self.at) as usize);
        self.held.resize(want, 0);
        self.inner.seek(SeekFrom::Start(self.at))?;
        let mut filled = 0;
        while filled < want {
            let n = self.inner.read(&mut self.held[filled..])?;
            if n == 0 {
                break;
            }
            filled += n;
        }
        self.held.truncate(filled);
        self.held_from = self.at;
        self.requests.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
}

impl<R: Read + Seek> Read for ReadAhead<R> {
    fn read(&mut self, out: &mut [u8]) -> Result<usize> {
        if self.at >= self.len || out.is_empty() {
            return Ok(0);
        }
        if self.at < self.held_from || self.at >= self.held_until() {
            self.fetch()?;
        }
        let from = (self.at - self.held_from) as usize;
        let n = out.len().min(self.held.len() - from);
        out[..n].copy_from_slice(&self.held[from..from + n]);
        self.at += n as u64;
        Ok(n)
    }
}

impl<R: Read + Seek> Seek for ReadAhead<R> {
    /// A seek asks the file for nothing: only the next read does, if it falls outside what is held.
    fn seek(&mut self, to: SeekFrom) -> Result<u64> {
        let target = match to {
            SeekFrom::Start(p) => p as i128,
            SeekFrom::End(d) => self.len as i128 + d as i128,
            SeekFrom::Current(d) => self.at as i128 + d as i128,
        };
        if target < 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "seek before start"));
        }
        self.at = target as u64;
        Ok(self.at)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn numbered(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i % 251) as u8).collect()
    }

    #[test]
    fn what_is_read_is_what_the_file_holds_wherever_the_reads_fall() {
        let bytes = numbered(3 * CARRYING_ON + 12_345);
        let mut reader = ReadAhead::new(Cursor::new(bytes.clone())).unwrap();
        // Through the whole file in odd-sized reads, then back to places already passed.
        let mut all = Vec::new();
        let mut chunk = vec![0u8; 7_001];
        loop {
            let n = reader.read(&mut chunk).unwrap();
            if n == 0 {
                break;
            }
            all.extend_from_slice(&chunk[..n]);
        }
        assert_eq!(all, bytes);
        for from in [0usize, 5, AFTER_A_JUMP - 1, CARRYING_ON + 3, bytes.len() - 10] {
            reader.seek(SeekFrom::Start(from as u64)).unwrap();
            let mut some = vec![0u8; 10];
            reader.read_exact(&mut some).unwrap();
            assert_eq!(some, bytes[from..from + 10]);
        }
        assert_eq!(reader.seek(SeekFrom::End(-4)).unwrap(), bytes.len() as u64 - 4);
        assert!(reader.seek(SeekFrom::Current(-(bytes.len() as i64) - 1)).is_err());
    }

    #[test]
    fn a_jump_asks_once_and_reading_on_asks_a_megabyte_at_a_time() {
        let mut reader = ReadAhead::new(Cursor::new(numbered(4 * CARRYING_ON))).unwrap();
        let requests = reader.requests();
        let asked = || requests.load(Ordering::Relaxed);

        // A header: a few small reads at one place are one request.
        reader.seek(SeekFrom::Start(2_000_000)).unwrap();
        let mut small = [0u8; 7];
        reader.read_exact(&mut small).unwrap();
        reader.read_exact(&mut small).unwrap();
        // Seeking to where it already is, as the RAR reader does before each read, asks for nothing.
        reader.seek(SeekFrom::Start(2_000_014)).unwrap();
        reader.read_exact(&mut small).unwrap();
        assert_eq!(asked(), 1);

        // A page of 1.2 MB in 8 KB reads, from a place not held: three requests, not a hundred and fifty.
        reader.seek(SeekFrom::Start(100)).unwrap();
        let mut chunk = [0u8; 8192];
        for _ in 0..150 {
            reader.read_exact(&mut chunk).unwrap();
        }
        assert_eq!(asked(), 1 + 3);
    }
}
