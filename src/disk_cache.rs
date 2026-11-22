use reqwest::Url;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const MAX_ENTRIES: usize = 256;
const MAX_ENTRY_BYTES: usize = 128 * 1024;

#[derive(Clone)]
pub(super) struct DiskCache {
    db: Arc<Mutex<Connection>>,
    ttl: i64,
}

impl DiskCache {
    pub(super) fn open(path: &Path, ttl: u64) -> rusqlite::Result<Self> {
        let db = Connection::open(path)?;
        db.busy_timeout(Duration::from_millis(100))?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS rustxng_search_cache (
                 key BLOB PRIMARY KEY,
                 response BLOB NOT NULL,
                 saved INTEGER NOT NULL
             ) WITHOUT ROWID;",
        )?;
        Ok(Self {
            db: Arc::new(Mutex::new(db)),
            ttl: ttl.min(3600) as i64,
        })
    }

    pub(super) async fn read(&self, url: &Url) -> Option<Value> {
        let key = cache_key(url);
        let db = self.db.clone();
        let earliest = now() - self.ttl;
        let bytes = tokio::task::spawn_blocking(move || {
            let db = db.lock().ok()?;
            db.query_row(
                "SELECT response FROM rustxng_search_cache
                 WHERE key = ?1 AND saved > ?2 AND saved <= ?3 AND length(response) <= ?4",
                params![key.as_slice(), earliest, now(), MAX_ENTRY_BYTES],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .optional()
            .ok()
            .flatten()
        })
        .await
        .ok()
        .flatten()?;
        serde_json::from_slice(&bytes).ok()
    }

    pub(super) async fn save(&self, url: &Url, value: &Value) {
        let Ok(bytes) = serde_json::to_vec(value) else {
            return;
        };
        if bytes.len() > MAX_ENTRY_BYTES {
            return;
        }
        let key = cache_key(url);
        let db = self.db.clone();
        let ttl = self.ttl;
        let _ = tokio::task::spawn_blocking(move || {
            let Ok(mut db) = db.lock() else {
                return Ok(());
            };
            let current = now();
            let tx = db.transaction()?;
            tx.execute(
                "DELETE FROM rustxng_search_cache WHERE saved <= ?1",
                [current - ttl],
            )?;
            tx.execute(
                "INSERT INTO rustxng_search_cache (key, response, saved) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET response = excluded.response, saved = excluded.saved",
                params![key.as_slice(), bytes, current],
            )?;
            tx.execute(
                "DELETE FROM rustxng_search_cache WHERE key IN (
                    SELECT key FROM rustxng_search_cache
                    ORDER BY saved DESC, key LIMIT -1 OFFSET ?1
                )",
                [MAX_ENTRIES],
            )?;
            tx.commit()
        })
        .await;
    }
}

fn cache_key(url: &Url) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(b"rustxng-search-v1\0");
    hash.update(url.as_str().as_bytes());
    hash.finalize().into()
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reloads_cached_search_and_expires_entries() {
        let db = std::env::temp_dir().join(format!(
            "rustxng-cache-test-{}-{}.sqlite3",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let url = Url::parse("http://127.0.0.1:29483/search?q=tokio&language=en").unwrap();
        let other = Url::parse("http://127.0.0.1:29483/search?q=tokio&language=ru").unwrap();
        let value = serde_json::json!({"results":[{"title":"Tokio","url":"https://tokio.rs/","content":"Documentation"}]});
        let cache = DiskCache::open(&db, 600).unwrap();
        cache.save(&url, &value).await;
        drop(cache);

        let cache = DiskCache::open(&db, 600).unwrap();
        assert_eq!(cache.read(&url).await, Some(value));
        assert!(cache.read(&other).await.is_none());
        cache
            .db
            .lock()
            .unwrap()
            .execute("UPDATE rustxng_search_cache SET saved = 0", [])
            .unwrap();
        assert!(cache.read(&url).await.is_none());

        drop(cache);
        std::fs::remove_file(db).unwrap();
    }
}
